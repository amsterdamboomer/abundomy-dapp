/**
 * Identiteit & signup (Fase 4). Auth via een sleutelpaar dat **deterministisch uit de
 * seed** wordt afgeleid — los van de OrbitDB-identiteit.
 *
 * Belangrijk: de OrbitDB-identiteit (`orbitdb.identity`) is NIET reproduceerbaar uit de
 * seed (OrbitDB genereert een willekeurige sleutel en bewaart die in zijn keystore). Voor
 * login/wachtwoord-wijzigen/-reset moet de accountidentiteit op elk apparaat hetzelfde
 * zijn (een reset gebeurt juist vaak op een nieuw apparaat). Daarom leiden we de
 * account-keypair zelf af uit de seed (Ed25519) en ondertekenen we daarmee de claim/auth/
 * recovery. OrbitDB-writes blijven via de (wildcard-)store; de beveiliging zit in déze
 * handtekeningen, niet in de OrbitDB-ACL.
 */
import { generateKeyPairFromSeed, publicKeyFromRaw } from '@libp2p/crypto/keys'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { ZERO_HASH } from './config.mjs'
import { encryptUserProfile, decryptUserProfile } from './crypto.mjs'
import { openKeystore, rekeyKeystore, validatePassword } from './auth.mjs'
import { formatSqlDate } from './payments.mjs'

/** Deterministische account-identiteit uit de seed (Ed25519). Zelfde seed → zelfde pubkey. */
export async function deriveAccountKey(seed) {
  const priv = await generateKeyPairFromSeed('Ed25519', sha256(utf8ToBytes(seed)))
  return {
    pubkey: bytesToHex(priv.publicKey.raw),
    sign: async (msg) => bytesToHex(await priv.sign(utf8ToBytes(msg))),
  }
}

/** Verifieer een hex-handtekening tegen een account-pubkey (hex). */
async function verifyAccountSig(pubkeyHex, msg, sigHex) {
  if (!pubkeyHex || !sigHex) return false
  try {
    return await publicKeyFromRaw(hexToBytes(pubkeyHex)).verify(utf8ToBytes(msg), hexToBytes(sigHex))
  } catch { return false }
}

/** Het ondertekende statement dat een identiteit aan een usersId koppelt. */
const claimString = (usersId, pubkey) => `abundomy-claim:${usersId}:${pubkey}`
/** Het ondertekende statement over de wachtwoord-keystore (tamper-evidentie). */
const authString = (usersId, pubkey, auth) => `abundomy-auth:${usersId}:${pubkey}:${auth.ct}`
/** Idem voor de herstelkluis (seed versleuteld onder de e-mail-herstelcode). */
const recoveryString = (usersId, pubkey, recovery) => `abundomy-recovery:${usersId}:${pubkey}:${recovery.ct}`

/** Verifieer de ondertekende pubkey-claim op een user-doc. */
export async function verifyUserClaim({ userDoc }) {
  return verifyAccountSig(userDoc?.pubkey, claimString(userDoc?.usersId, userDoc?.pubkey), userDoc?.claimSig)
}

/** Verifieer de handtekening over de keystore (alleen de eigenaar kan 'm zetten). */
export async function verifyAuthSig({ userDoc }) {
  if (!userDoc?.auth) return false
  return verifyAccountSig(userDoc.pubkey, authString(userDoc.usersId, userDoc.pubkey, userDoc.auth), userDoc.authSig)
}

/** Verifieer de handtekening over de herstelkluis. */
export async function verifyRecoverySig({ userDoc }) {
  if (!userDoc?.recovery) return false
  return verifyAccountSig(userDoc.pubkey, recoveryString(userDoc.usersId, userDoc.pubkey, userDoc.recovery), userDoc.recoverySig)
}

/** Profiel-/identiteitshash voor een nieuwe gebruiker (legacy `users.hash`, ascii). */
function profileHash(usersId, pubkey, start) {
  return bytesToHex(sha256(utf8ToBytes(`${usersId}${pubkey}${start}`)))
}

/**
 * Bind de account-identiteit (uit de seed) aan een bestaande (gemigreerde) usersId.
 * @returns het bijgewerkte user-doc met `pubkey` + `claimSig`.
 */
export async function claimUser({ stores, seed, usersId }) {
  const doc = (await stores.users.get(usersId))?.value
  if (!doc) throw new Error(`user ${usersId} niet gevonden`)
  const account = await deriveAccountKey(seed)
  const claimed = { ...doc, pubkey: account.pubkey, claimSig: await account.sign(claimString(usersId, account.pubkey)) }
  await stores.users.put(claimed)
  return claimed
}

/**
 * Nieuwe gebruiker registreren: profiel client-side versleuteld + ondertekende
 * pubkey-claim. `usersId` = hoogste bestaande + 1.
 *
 * `auth` (optioneel) = een met het wachtwoord versleutelde keystore (zie auth.mjs);
 * die wordt apart ondertekend (`authSig`) zodat alleen de eigenaar 'm kan wijzigen.
 * `recovery` (optioneel) = dezelfde seed versleuteld onder de e-mail-herstelcode.
 * De username (`profile.usersUid`) moet uniek zijn (legacy "usernametaken").
 *
 * @param {{stores, seed:string, profile:object, communityKey, auth?:object, recovery?:object, asOf?:Date}} args
 * @returns het opgeslagen (versleutelde, geclaimde) user-doc.
 */
export async function signup({ stores, seed, profile, communityKey, auth, recovery, asOf = new Date() }) {
  const all = await stores.users.all()
  const uid = (profile.usersUid ?? '').trim()
  if (uid && all.some((e) => (e.value.usersUid ?? '').toLowerCase() === uid.toLowerCase())) {
    throw new Error('usernametaken')
  }
  const usersId = all.reduce((m, e) => Math.max(m, e.value.usersId), 0) + 1
  const account = await deriveAccountKey(seed)
  const pubkey = account.pubkey
  const start = formatSqlDate(asOf)
  const base = {
    usersId,
    usersName: profile.usersName ?? '',
    usersUid: profile.usersUid ?? '',
    language: profile.language ?? 'en',
    start,
    lastHash: ZERO_HASH,
    hash: profileHash(usersId, pubkey, start),
    useWhitelist: 0,
    newsletter: 1,
    paymentEmails: 1,
    ...profile, // bevat ook de gevoelige velden (image, birthday, height, …)
    usersId, // niet overschrijfbaar via profile
  }
  const encDoc = await encryptUserProfile(base, communityKey)
  const doc = { ...encDoc, pubkey, claimSig: await account.sign(claimString(usersId, pubkey)) }
  if (auth) {
    doc.auth = auth
    doc.authSig = await account.sign(authString(usersId, pubkey, auth))
  }
  if (recovery) {
    doc.recovery = recovery
    doc.recoverySig = await account.sign(recoveryString(usersId, pubkey, recovery))
  }
  await stores.users.put(doc)
  return doc
}

/**
 * Profielvelden bijwerken (alleen de eigenaar, in een ingelogde sessie). De gevoelige
 * velden worden opnieuw versleuteld; identiteit (`pubkey`/`claimSig`), keystore
 * (`auth`/`authSig`) en herstelkluis (`recovery`/`recoverySig`) blijven behouden en
 * geldig — die handtekeningen gaan over `usersId`/`pubkey`/keystore, niet over het
 * profiel. `usersId` is niet overschrijfbaar. Wijzigt de gebruikersnaam? Dan moet die
 * uniek blijven (legacy "usernametaken").
 *
 * @param {{stores, usersId:number, updates:object, communityKey}} args
 * @returns het opgeslagen (versleutelde) user-doc.
 */
export async function updateProfile({ stores, usersId, updates, communityKey }) {
  const stored = (await stores.users.get(usersId))?.value
  if (!stored) throw new Error('account niet gevonden')

  const newUid = (updates.usersUid ?? '').trim()
  if (newUid) {
    const all = await stores.users.all()
    if (all.some((e) => e.value.usersId !== usersId && (e.value.usersUid ?? '').toLowerCase() === newUid.toLowerCase())) {
      throw new Error('usernametaken')
    }
  }

  const current = await decryptUserProfile(stored, communityKey)
  const merged = { ...current, ...updates, usersId } // usersId niet overschrijfbaar
  const encDoc = await encryptUserProfile(merged, communityKey)
  await stores.users.put(encDoc)
  return encDoc
}

/**
 * Zet een verse wachtwoord-keystore op basis van een al-bekende seed (gedeeld door de
 * wijzig- en reset-flow). De accountidentiteit komt uit de seed; de guard zorgt dat de
 * seed bij het account hoort (zelfde deterministische pubkey).
 */
export async function rekeyAuth({ stores, seed, usersId, newPassword }) {
  const doc = (await stores.users.get(usersId))?.value
  if (!doc) throw new Error('account niet gevonden')
  const account = await deriveAccountKey(seed)
  if (doc.pubkey && doc.pubkey !== account.pubkey) throw new Error('dit is niet jouw account')
  const pwdErr = validatePassword(newPassword)
  if (pwdErr) throw new Error(pwdErr)
  const auth = await rekeyKeystore(seed, newPassword)
  const updated = { ...doc, auth, authSig: await account.sign(authString(usersId, account.pubkey, auth)) }
  await stores.users.put(updated)
  return updated
}

/**
 * Wachtwoord wijzigen — alleen de eigenaar. Vereist het **huidige** wachtwoord (om de
 * seed uit de keystore te halen). De seed/identiteit blijft ongewijzigd, dus saldo,
 * keten en pubkey-claim blijven geldig.
 *
 * @param {{stores, usersId:number, currentPassword:string, newPassword:string}} args
 * @returns het bijgewerkte user-doc.
 */
export async function changePassword({ stores, usersId, currentPassword, newPassword }) {
  const doc = (await stores.users.get(usersId))?.value
  if (!doc?.auth) throw new Error('dit account heeft geen wachtwoord-keystore')
  const seed = await openKeystore(doc.auth, currentPassword) // gooit 'verkeerd wachtwoord'
  return rekeyAuth({ stores, seed, usersId, newPassword })
}
