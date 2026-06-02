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
import { signup, claimUser, verifyUserClaim, verifyAuthSig, updateProfile } from '../src/identity.mjs'

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
  assert.ok(doc.usersId > 0)
  assert.ok(doc.pubkey && doc.claimSig, 'claim aanwezig')
  assert.equal(doc.height, undefined, 'gevoelig veld niet in clear')
  assert.ok(doc.enc, 'enc-blob aanwezig')
  assert.equal(await verifyUserClaim({ userDoc: doc }), true)

  const plain = await decryptUserProfile(doc, key)
  assert.equal(plain.height, '1.75m')
  assert.equal(plain.specialFeatures, 'tattoo')
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
