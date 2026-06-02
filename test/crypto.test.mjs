/**
 * Fase 4: profielversleuteling (gedeelde community-sleutel). Pure tests.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveCommunityKey, encryptUserProfile, decryptUserProfile, SENSITIVE_FIELDS } from '../src/crypto.mjs'

const sampleUser = {
  usersId: 42, usersName: 'Teun', start: '2026-01-01 00:00:00', hash: 'abc',
  usersEmail: 'teun@x.nl', height: '1.80m', hair: 12, birthday: '1965-02-13',
  specialFeatures: 'Scar under left eye', leftEye: 8, rightEye: 8, gender: 0, image: 'data:image/png;base64,AAAA',
}

test('encrypt/decrypt round-trip herstelt het volledige profiel', async () => {
  const key = await deriveCommunityKey('community-secret')
  const encDoc = await encryptUserProfile(sampleUser, key)
  const back = await decryptUserProfile(encDoc, key)
  assert.deepEqual(back, sampleUser)
})

test('gevoelige velden zitten niet leesbaar in het opgeslagen doc', async () => {
  const key = await deriveCommunityKey('community-secret')
  const encDoc = await encryptUserProfile(sampleUser, key)
  for (const f of SENSITIVE_FIELDS) assert.ok(!(f in encDoc), `${f} mag niet in clear`)
  assert.ok(encDoc.enc?.iv && encDoc.enc?.ct, 'enc-blob aanwezig')
  const serialized = JSON.stringify(encDoc)
  assert.ok(!serialized.includes('Scar under left eye'), 'plaintext niet in ciphertext')
  assert.ok(!serialized.includes('teun@x.nl'), 'e-mail niet in clear')
})

test('leesbare velden (id/naam/start/hash) blijven behouden', async () => {
  const key = await deriveCommunityKey('community-secret')
  const encDoc = await encryptUserProfile(sampleUser, key)
  assert.equal(encDoc.usersId, 42)
  assert.equal(encDoc.usersName, 'Teun')
  assert.equal(encDoc.start, '2026-01-01 00:00:00')
  assert.equal(encDoc.hash, 'abc')
})

test('verkeerde sleutel kan niet ontsleutelen', async () => {
  const key = await deriveCommunityKey('community-secret')
  const wrong = await deriveCommunityKey('ander-geheim')
  const encDoc = await encryptUserProfile(sampleUser, key)
  await assert.rejects(() => decryptUserProfile(encDoc, wrong))
})
