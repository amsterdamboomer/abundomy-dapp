/**
 * Fase 4: signup + ondertekende pubkey-claim. Integratie op een echte OrbitDB-node.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { startNode, stopNode } from '../src/orbit.mjs'
import { openStores, closeStores } from '../src/stores.mjs'
import { deriveCommunityKey, decryptUserProfile } from '../src/crypto.mjs'
import { signup, claimUser, verifyUserClaim, verifyAuthSig, verifyRecoverySig, updateProfile, repairIdentity, deriveAccountKey } from '../src/identity.mjs'
import { createKeystore, openKeystore, generateRecoveryCode, normalizeRecoveryCode } from '../src/auth.mjs'
import { joinedDate } from '../src/ledger.mjs'

const root = fileURLToPath(new URL('../.abundomy-poc/test-identity/', import.meta.url))
let node, stores, key

before(async () => {
  rmSync(root, { recursive: true, force: true })
  node = await startNode({ persist: true, id: 'identity-test', root })
  stores = await openStores(node.orbitdb, { write: ['*'] })
  key = await deriveCommunityKey('test-secret')
})
after(async () => {
  if (stores) await closeStores(stores)
  if (node) await stopNode(node)
})

test('signup: versleuteld profiel + geldige ondertekende claim', { timeout: 60_000 }, async () => {
  const doc = await signup({
    stores, seed: 'seed-nieuw-lid',
    profile: { usersName: 'Nieuw Lid', height: '1.75m', birthday: '1990-05-05', specialFeatures: 'tattoo' },
    communityKey: key,
  })
  assert.ok(doc.usersId >= 10 && doc.usersId <= 99999, 'usersId in kort bereik [10, 99999]')
  assert.ok(Number.isInteger(doc.usersId))
  assert.ok(doc.pubkey && doc.claimSig, 'claim aanwezig')
  assert.equal(doc.height, undefined, 'gevoelig veld niet in clear')
  assert.ok(doc.enc, 'enc-blob aanwezig')
  assert.equal(await verifyUserClaim({ userDoc: doc }), true)

  const plain = await decryptUserProfile(doc, key)
  assert.equal(plain.height, '1.75m')
  assert.equal(plain.specialFeatures, 'tattoo')
})

test('signup overschrijft GEEN bestaand account met een lage usersId (collision-fix)', { timeout: 60_000 }, async () => {
  // Simuleer een bestaand legacy-account op id=1 (zoals Patrick) — net als wanneer de store
  // pas deels gesynct is en max+1 ten onrechte 1 zou kiezen.
  await stores.users.put({ usersId: 1, usersUid: 'LegacyEen', pubkey: 'aa', start: '2020-01-01' })
  const before = (await stores.users.get(1))?.value

  const doc = await signup({
    stores, seed: 'collision-seed-xyz',
    profile: { usersName: 'Verse', usersUid: 'verseLid' }, communityKey: key,
  })
  assert.notEqual(doc.usersId, 1, 'nieuwe usersId botst niet met bestaande id=1')

  const after = (await stores.users.get(1))?.value
  assert.equal(after.usersUid, 'LegacyEen', 'bestaand id=1-account is NIET overschreven')
  assert.equal(after.pubkey, before.pubkey, 'pubkey van id=1 ongemoeid')
  assert.equal(await verifyUserClaim({ userDoc: doc }), true, 'claim van het nieuwe account klopt')
})

test('repairIdentity: herstelt een Frankenstein-doc (claim van X, auth/recovery van Y) → reset werkt weer', { timeout: 60_000 }, async () => {
  const seedA = 'echte-eigenaar-seed-A'
  const auth = await createKeystore(seedA, 'GoedWachtw00rd!')
  const recovery0 = await createKeystore(seedA, generateRecoveryCode())
  const doc0 = await signup({ stores, seed: seedA, profile: { usersName: 'X', usersUid: 'frankX' }, communityKey: key, auth, recovery: recovery0 })
  const id = doc0.usersId
  const A = await deriveAccountKey(seedA)

  // Maak het doc inconsistent: pubkey/claim van identiteit B, maar auth/recovery blijven van A.
  const B = await deriveAccountKey('andere-identiteit-seed-B')
  const franken = { ...(await stores.users.get(id)).value, pubkey: B.pubkey, claimSig: await B.sign(`abundomy-claim:${id}:${B.pubkey}`) }
  await stores.users.put(franken)
  assert.equal(await verifyUserClaim({ userDoc: franken }), true, 'claim klopt voor B')
  assert.equal(await verifyRecoverySig({ userDoc: franken }), false, 'recovery (van A) is ongeldig voor B → reset zou falen')

  // Repareer met de seed die de gebruiker ECHT bezit (A).
  const fix = await repairIdentity({ stores, seed: seedA, usersId: id })
  assert.equal(fix.repaired, true)
  const fixed = (await stores.users.get(id)).value
  assert.equal(fixed.pubkey, A.pubkey, 'pubkey terug naar de seed die de gebruiker bezit')
  assert.equal(await verifyUserClaim({ userDoc: fixed }), true)
  assert.equal(await verifyAuthSig({ userDoc: fixed }), true)
  assert.equal(await verifyRecoverySig({ userDoc: fixed }), true)

  // Reset werkt nu: de NIEUWE herstelcode opent de kluis → seed A → pubkey matcht.
  const seedBack = await openKeystore(fixed.recovery, normalizeRecoveryCode(fix.recoveryCode))
  assert.equal((await deriveAccountKey(seedBack)).pubkey, A.pubkey, 'herstelcode levert de juiste seed')

  // Idempotent: een tweede repair doet niets.
  assert.equal((await repairIdentity({ stores, seed: seedA, usersId: id })).repaired, false)
})

test('updateProfile: velden bijwerken, claim/keystore blijven geldig', { timeout: 60_000 }, async () => {
  const auth = { iv: 'aXY', ct: 'Y3Q' } // dummy-keystore (alleen handtekening telt hier)
  const doc = await signup({
    stores, seed: 'seed-edit', auth,
    profile: { usersName: 'Edit Mij', usersUid: 'editmij', height: '1.70m', hair: 3, usersEmail: 'edit@x.nl' },
    communityKey: key,
  })
  assert.equal(await verifyUserClaim({ userDoc: doc }), true)
  assert.equal(await verifyAuthSig({ userDoc: doc }), true)

  const updated = await updateProfile({
    stores, usersId: doc.usersId, communityKey: key,
    updates: { usersName: 'Aangepast', height: '1.99m', hair: 17 },
  })
  // identiteit + keystore-handtekeningen blijven geldig (gaan niet over het profiel)
  assert.equal(updated.pubkey, doc.pubkey)
  assert.equal(await verifyUserClaim({ userDoc: updated }), true)
  assert.equal(await verifyAuthSig({ userDoc: updated }), true)

  const plain = await decryptUserProfile(updated, key)
  assert.equal(plain.usersName, 'Aangepast')
  assert.equal(plain.height, '1.99m')
  assert.equal(plain.hair, 17)
  assert.equal(plain.usersEmail, 'edit@x.nl', 'niet-gewijzigd veld blijft behouden')
})

test('updateProfile: profielwijziging archiveert de oude versie versleuteld in users_old', { timeout: 60_000 }, async () => {
  const doc = await signup({
    stores, seed: 'seed-historie',
    profile: { usersName: 'Versie Een', usersUid: 'histlid', height: '1.60m', hair: 2, birthday: '1980-01-01' },
    communityKey: key,
  })
  const id = doc.usersId
  const startSignup = (await stores.users.get(id)).value.start
  const mine = async () => (await stores.usersOld.all()).map((e) => e.value)
    .filter((o) => o.uid_old === id).sort((a, b) => Number(a.usersOldId.split('-').pop()) - Number(b.usersOldId.split('-').pop()))

  assert.equal((await mine()).length, 0, 'nog geen snapshot vóór de 1e wijziging')

  // zichtbaar profielveld wijzigen → snapshot van de OUDE versie
  await updateProfile({ stores, usersId: id, communityKey: key, updates: { height: '1.95m', hair: 9 } })
  let snaps = await mine()
  assert.equal(snaps.length, 1, '1 snapshot na 1 wijziging')
  assert.equal(snaps[0].start_old, startSignup, '1e snapshot start = inschrijfdatum')
  assert.ok(snaps[0].end_old, 'einddatum gezet')
  assert.equal(snaps[0].usersName, 'Versie Een')
  assert.equal(JSON.stringify(snaps[0]).includes('1.60m'), false, 'oude hoogte lekt niet onversleuteld')
  const oldPlain = await decryptUserProfile(snaps[0], key)
  assert.equal(oldPlain.height, '1.60m', 'gearchiveerde oude hoogte ontsleutelt')
  assert.equal(oldPlain.hair, 2)
  assert.equal(oldPlain.birthday, '1980-01-01')
  assert.equal(joinedDate({ usersId: id, start: startSignup }, snaps), startSignup, 'joinedDate blijft de inschrijfdatum')

  // niet-zichtbare wijziging (e-mail) → GEEN nieuwe snapshot
  await updateProfile({ stores, usersId: id, communityKey: key, updates: { usersEmail: 'nieuw@x.nl' } })
  assert.equal((await mine()).length, 1, 'e-mailwijziging voegt geen snapshot toe')

  // save zonder echte wijziging → GEEN snapshot
  await updateProfile({ stores, usersId: id, communityKey: key, updates: { height: '1.95m' } })
  assert.equal((await mine()).length, 1, 'ongewijzigde save voegt geen snapshot toe')

  // 2e zichtbare wijziging → 2e snapshot, begint waar de 1e eindigde
  await updateProfile({ stores, usersId: id, communityKey: key, updates: { height: '2.00m' } })
  snaps = await mine()
  assert.equal(snaps.length, 2, '2e snapshot na 2e wijziging')
  assert.equal(snaps[1].start_old, snaps[0].end_old, '2e versie begint bij het einde van de 1e')
  assert.equal((await decryptUserProfile(snaps[1], key)).height, '1.95m', '2e snapshot bewaart de tussenversie')
})

test('foto: data-URI wordt versleuteld opgeslagen en round-trips (signup + updateProfile)', { timeout: 60_000 }, async () => {
  const photo = 'data:image/jpeg;base64,/9j/TESTDATA=='
  const doc = await signup({
    stores, seed: 'seed-foto',
    profile: { usersName: 'Foto Lid', usersUid: 'fotolid', image: photo },
    communityKey: key,
  })
  // foto staat NIET in de clear (zit in de versleutelde enc-blob)
  assert.equal(doc.image, undefined, 'foto niet in clear')
  assert.ok(doc.enc, 'enc-blob aanwezig')
  assert.equal(JSON.stringify(doc).includes('TESTDATA'), false, 'foto lekt niet onversleuteld')
  assert.equal((await decryptUserProfile(doc, key)).image, photo, 'foto round-trip na signup')

  // foto wijzigen via updateProfile
  const photo2 = 'data:image/jpeg;base64,/9j/NIEUW=='
  const upd = await updateProfile({ stores, usersId: doc.usersId, communityKey: key, updates: { image: photo2 } })
  assert.equal(upd.image, undefined, 'foto niet in clear na update')
  assert.equal((await decryptUserProfile(upd, key)).image, photo2, 'nieuwe foto round-trip')

  // foto verwijderen (lege string)
  const cleared = await updateProfile({ stores, usersId: doc.usersId, communityKey: key, updates: { image: '' } })
  assert.equal((await decryptUserProfile(cleared, key)).image, '', 'foto verwijderd')
})

test('updateProfile: dubbele gebruikersnaam wordt geweigerd', { timeout: 60_000 }, async () => {
  await signup({ stores, seed: 'seed-a', profile: { usersName: 'A', usersUid: 'bezet' }, communityKey: key })
  const b = await signup({ stores, seed: 'seed-b', profile: { usersName: 'B', usersUid: 'vrij' }, communityKey: key })
  await assert.rejects(
    updateProfile({ stores, usersId: b.usersId, communityKey: key, updates: { usersUid: 'BEZET' } }),
    /usernametaken/,
  )
})

test('geknoeide claim verifieert niet', async () => {
  const doc = await signup({ stores, seed: 'seed-knoei', profile: { usersName: 'Knoei' }, communityKey: key })
  const tampered = { ...doc, usersId: doc.usersId + 999 } // claim was voor de oude id
  assert.equal(await verifyUserClaim({ userDoc: tampered }), false)
})

test('claimUser bindt identiteit aan een bestaande (gemigreerde) usersId', async () => {
  await stores.users.put({ usersId: 777, usersName: 'Bestaand', start: '2026-01-01 00:00:00', hash: 'zz' })
  const claimed = await claimUser({ stores, seed: 'abundomy-user-777', usersId: 777 })
  assert.ok(claimed.pubkey && claimed.claimSig)
  assert.equal(await verifyUserClaim({ userDoc: claimed }), true)
})
