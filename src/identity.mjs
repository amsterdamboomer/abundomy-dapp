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
import { openKeystore, rekeyKeystore, validatePassword, createKeystore, generateRecoveryCode, formatRecoveryCode } from './auth.mjs'
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
 * Botsingsvrije `usersId`, **deterministisch uit de pubkey**, in een KORT bereik [10, 99999].
 * Vervangt het oude `max(bestaande)+1`: dat las de lokale `users`-store, dus bij een nog niet
 * (volledig) gesyncte store koos het een lage id (vaak 1) en OVERSCHREEF een bestaand account
 * (Documents `indexBy:'usersId'` = last-write-wins). Een pubkey-afgeleide id vergt geen
 * coördinatie → geen collision, ongeacht de sync-stand.
 *
 * Het getal wordt op een klein, leesbaar bereik gemapt (≥10, dus geen botsing met de bestaande
 * lage ids 1-4 en geen onhandelbaar lange nummers). `existingIds` vangt de — bij dit kleinere
 * bereik wat grotere, maar nog steeds kleine — kans op een botsing af door te herhashen, en
 * slaat zo ook al-gebruikte ids over. Blijft numeriek.
 */
function deriveUserId(pubkey, existingIds, salt = 0) {
  const hex = bytesToHex(sha256(utf8ToBytes(`abundomy-uid:${pubkey}:${salt}`))).slice(0, 12) // 48 bits ruwe entropie
  const id = 10 + (parseInt(hex, 16) % 99990) // map naar kort bereik [10, 99999]
  return existingIds.has(id) ? deriveUserId(pubkey, existingIds, salt + 1) : id
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
 * pubkey-claim. `usersId` = botsingsvrij uit de pubkey afgeleid (zie deriveUserId).
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
  const account = await deriveAccountKey(seed)
  const pubkey = account.pubkey
  // Botsingsvrije usersId uit de pubkey (zie deriveUserId) i.p.v. lokale `max+1`, dat bij een
  // nog niet-gesyncte store een lage, botsende id koos en bestaande accounts overschreef.
  const usersId = deriveUserId(pubkey, new Set(all.map((e) => e.value.usersId)))
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
 * Repareer een "Frankenstein"-user-doc dat door historische usersId-collisions inconsistent
 * raakte: `pubkey`/`claimSig` van identiteit X, maar `auth`/`recovery` van identiteit Y.
 * Bij login levert het wachtwoord (via `openKeystore(auth, pwd)`) de seed die de gebruiker
 * ECHT bezit; als die niet bij `doc.pubkey` past, is reset kapot ("dit is niet jouw account").
 *
 * We herschrijven het doc consistent met díe seed: nieuwe `pubkey`, verse `claimSig`, en —
 * omdat de oude `auth`-kluis al door dit wachtwoord ontsleuteld is en dus bij deze seed hoort —
 * alleen een nieuwe `authSig`. De `recovery`-kluis hoorde bij de andere identiteit en wordt
 * VERVANGEN door een verse kluis (nieuwe herstelcode wordt teruggegeven zodat de gebruiker 'm
 * kan bewaren — anders blijft reset onmogelijk). `hash` (profileHash) is vestigiaal (niet in de
 * grootboekketen) maar wordt voor consistentie herberekend. Idempotent: niets als al consistent.
 *
 * @returns {Promise<{repaired:boolean, recoveryCode?:string, pubkey?:string}>}
 */
export async function repairIdentity({ stores, seed, usersId }) {
  const stored = (await stores.users.get(usersId))?.value
  if (!stored) throw new Error(`user ${usersId} niet gevonden`)
  const account = await deriveAccountKey(seed)
  const pubkey = account.pubkey
  const authOk = stored.auth ? await verifyAuthSig({ userDoc: stored }) : true
  const recOk = stored.recovery ? await verifyRecoverySig({ userDoc: stored }) : true
  if (stored.pubkey === pubkey && authOk && recOk) return { repaired: false }

  const recoveryRaw = generateRecoveryCode()
  const recovery = await createKeystore(seed, recoveryRaw)
  const doc = {
    ...stored,
    pubkey,
    hash: profileHash(usersId, pubkey, stored.start),
    claimSig: await account.sign(claimString(usersId, pubkey)),
    recovery,
    recoverySig: await account.sign(recoveryString(usersId, pubkey, recovery)),
  }
  if (doc.auth) doc.authSig = await account.sign(authString(usersId, pubkey, doc.auth))
  await stores.users.put(doc)
  return { repaired: true, recoveryCode: formatRecoveryCode(recoveryRaw), pubkey }
}

/** Zichtbare profielvelden waarvan een wijziging een historie-snapshot waard is (precies
 *  de velden die het PDF-overzicht toont). Login-handle, e-mail en privacy-vlaggen NIET. */
const HISTORY_FIELDS = ['usersName', 'image', 'birthday', 'gender', 'height', 'hair', 'leftEye', 'rightEye', 'specialFeatures']

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

  // Profielhistorie: archiveer de OUDE versie in `users_old` vóór de overschrijving,
  // maar alleen als een zichtbaar profielveld écht wijzigt (geen snapshot bij een
  // e-mail-/whitelist-toggle of een save zonder wijziging). De oude `enc`-blob gaat
  // 1-op-1 mee → blijft AES-GCM-versleuteld; auth/recovery/pubkey worden BEWUST niet
  // gearchiveerd (onnodige aanvalsoppervlakte in een publieke store).
  const norm = (v) => (v == null ? '' : v)
  const profileChanged = HISTORY_FIELDS.some((f) => f in updates && norm(updates[f]) !== norm(current[f]))
  if (profileChanged && stores.usersOld) {
    const now = new Date()
    const mine = (await stores.usersOld.all()).map((e) => e.value).filter((o) => o.uid_old === usersId)
    // Validiteit van de gearchiveerde versie: van het einde van de vorige versie (of de
    // inschrijfdatum bij de 1e snapshot — zo blijft joinedDate = MIN(start_old) ongemoeid)
    // tot nu. `usersOldId` uniek per gebruiker per moment (ms) → geen overschrijving.
    const lastEnd = mine.reduce((m, o) => (o.end_old && o.end_old > m ? o.end_old : m), null)
    await stores.usersOld.put({
      usersOldId: `${usersId}-${now.getTime()}`,
      uid_old: usersId,
      start_old: lastEnd ?? stored.start ?? current.start,
      end_old: formatSqlDate(now),
      usersName: stored.usersName,
      enc: stored.enc,
    })
  }

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
