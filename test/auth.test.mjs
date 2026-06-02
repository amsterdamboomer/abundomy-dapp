/**
 * Fase 4: wachtwoord-keystore (auth.mjs) + signup-integratie.
 * Pure keystore-tests draaien zonder IPFS; de integratie op een echte OrbitDB-node.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createKeystore, openKeystore, rekeyKeystore, validatePassword, generateRecoveryCode, formatRecoveryCode, normalizeRecoveryCode } from '../src/auth.mjs'
import { startNode, stopNode } from '../src/orbit.mjs'
import { openStores, closeStores } from '../src/stores.mjs'
import { deriveCommunityKey } from '../src/crypto.mjs'
import { signup, verifyAuthSig, verifyRecoverySig, changePassword, rekeyAuth, deriveAccountKey } from '../src/identity.mjs'

const PWD = 'Geheim1!xx'
const SEED = 'abundomy-7f3a-test-seed'

test('keystore: roundtrip met juist wachtwoord', async () => {
  const ks = await createKeystore(SEED, PWD)
  assert.deepEqual(Object.keys(ks).sort(), ['ct', 'iter', 'iv', 'kdf', 'salt', 'v'])
  assert.equal(await openKeystore(ks, PWD), SEED)
})

test('keystore: fout wachtwoord faalt (GCM-auth-tag)', async () => {
  const ks = await createKeystore(SEED, PWD)
  await assert.rejects(() => openKeystore(ks, 'Anders9!xx'), /verkeerd wachtwoord/)
})

test('keystore: rekey behoudt de seed, oud wachtwoord werkt niet meer', async () => {
  const ks = await createKeystore(SEED, PWD)
  const ks2 = await rekeyKeystore(SEED, 'NieuwPwd2@')
  assert.equal(await openKeystore(ks2, 'NieuwPwd2@'), SEED, 'zelfde seed onder nieuw wachtwoord')
  await assert.rejects(() => openKeystore(ks2, PWD), /verkeerd wachtwoord/, 'oud wachtwoord faalt')
  assert.notEqual(ks.salt, ks2.salt, 'nieuwe salt')
})

test('herstelcode: genereren / formatteren / normaliseren is rond', () => {
  const raw = generateRecoveryCode()
  assert.match(raw, /^[A-Z2-9]{20}$/, 'ruwe code is base32 zonder verwarrende tekens')
  assert.equal(normalizeRecoveryCode(formatRecoveryCode(raw)), raw, 'format → normalize == raw')
  assert.equal(normalizeRecoveryCode('abcd-efgh ijkl'), 'ABCDEFGHIJKL', 'streepjes/spaties weg, hoofdletters')
})

test('herstelkluis: ontsleutelt naar de seed met de juiste code', async () => {
  const raw = generateRecoveryCode()
  const vault = await createKeystore(SEED, raw)
  assert.equal(await openKeystore(vault, raw), SEED)
  await assert.rejects(() => openKeystore(vault, generateRecoveryCode()), /verkeerd wachtwoord/)
})

test('validatePassword: eisen (>7, az+AZ+09+speciaal)', () => {
  assert.match(validatePassword('Ab1!'), /langer dan 7/)
  assert.match(validatePassword('alllowercase1!'), /hoofdletter/)
  assert.match(validatePassword('ALLUPPERCASE1!'), /kleine letter/)
  assert.match(validatePassword('GeenCijfers!!'), /cijfer/)
  assert.match(validatePassword('GeenSpeciaal1'), /speciaal teken/)
  assert.equal(validatePassword('Geheim1!xx'), null)
})

// --- integratie: signup schrijft de keystore + ondertekent 'm ---
const root = fileURLToPath(new URL('../.abundomy-poc/test-auth/', import.meta.url))
let node, stores, key

before(async () => {
  rmSync(root, { recursive: true, force: true })
  node = await startNode({ persist: true, id: 'auth-test', root })
  stores = await openStores(node.orbitdb, { write: ['*'] })
  key = await deriveCommunityKey('test-secret')
})
after(async () => {
  if (stores) await closeStores(stores)
  if (node) await stopNode(node)
})

test('signup met keystore: auth + geldige authSig opgeslagen', { timeout: 60_000 }, async () => {
  const auth = await createKeystore(SEED, PWD)
  const doc = await signup({
    stores, seed: SEED, profile: { usersName: 'Wachtwoord Lid', usersUid: 'alice' }, communityKey: key, auth,
  })
  assert.ok(doc.auth?.ct, 'keystore in het doc')
  assert.ok(doc.authSig, 'authSig aanwezig')
  assert.equal(await verifyAuthSig({ userDoc: doc }), true)
  assert.equal(await openKeystore(doc.auth, PWD), SEED, 'keystore ontsleutelt naar de seed')
})

test('signup: geknoeide keystore verifieert niet', async () => {
  const auth = await createKeystore(SEED, PWD)
  const doc = await signup({
    stores, seed: SEED, profile: { usersName: 'Knoei', usersUid: 'bob' }, communityKey: key, auth,
  })
  const tampered = { ...doc, auth: { ...doc.auth, ct: doc.auth.ct.slice(0, -4) + 'AAAA' } }
  assert.equal(await verifyAuthSig({ userDoc: tampered }), false)
})

test('signup: dubbele gebruikersnaam (hoofdletterongevoelig) → usernametaken', async () => {
  const auth = await createKeystore(SEED, PWD)
  await assert.rejects(() => signup({
    stores, seed: SEED, profile: { usersName: 'Tweede Alice', usersUid: 'ALICE' }, communityKey: key, auth,
  }), /usernametaken/)
})

test('account-identiteit is deterministisch uit de seed (zelfde pubkey op elk apparaat)', () => {
  // pubkey hangt alléén van de seed af, niet van een (per-apparaat) OrbitDB-keystore
  return Promise.all([deriveAccountKey('zelfde-seed'), deriveAccountKey('zelfde-seed'), deriveAccountKey('andere-seed')])
    .then(([a, b, c]) => {
      assert.equal(a.pubkey, b.pubkey, 'zelfde seed → zelfde pubkey')
      assert.notEqual(a.pubkey, c.pubkey, 'andere seed → andere pubkey')
    })
})

test('changePassword: nieuw wachtwoord werkt, oud niet; identiteit blijft', { timeout: 60_000 }, async () => {
  const doc = await signup({
    stores, seed: SEED, profile: { usersName: 'Carol', usersUid: 'carol' }, communityKey: key,
    auth: await createKeystore(SEED, PWD),
  })
  const updated = await changePassword({ stores, usersId: doc.usersId, currentPassword: PWD, newPassword: 'NieuwPwd2@' })
  assert.equal(await openKeystore(updated.auth, 'NieuwPwd2@'), SEED, 'nieuw wachtwoord ontsleutelt de seed')
  await assert.rejects(() => openKeystore(updated.auth, PWD), /verkeerd wachtwoord/, 'oud wachtwoord werkt niet meer')
  assert.equal(updated.pubkey, doc.pubkey, 'pubkey/identiteit ongewijzigd')
  assert.equal(await verifyAuthSig({ userDoc: updated }), true, 'nieuwe authSig geldig')
})

test('changePassword: verkeerd huidig wachtwoord wordt geweigerd', async () => {
  const doc = await signup({
    stores, seed: SEED, profile: { usersName: 'Dave', usersUid: 'dave' }, communityKey: key,
    auth: await createKeystore(SEED, PWD),
  })
  await assert.rejects(() => changePassword({
    stores, usersId: doc.usersId, currentPassword: 'FoutPwd9!', newPassword: 'NieuwPwd2@',
  }), /verkeerd wachtwoord/)
})

test('signup met herstelkluis: recovery + geldige recoverySig opgeslagen', { timeout: 60_000 }, async () => {
  const code = generateRecoveryCode()
  const doc = await signup({
    stores, seed: SEED, profile: { usersName: 'Eve', usersUid: 'eve' }, communityKey: key,
    auth: await createKeystore(SEED, PWD), recovery: await createKeystore(SEED, code),
  })
  assert.ok(doc.recovery?.ct, 'herstelkluis in het doc')
  assert.equal(await verifyRecoverySig({ userDoc: doc }), true)
  assert.equal(await openKeystore(doc.recovery, code), SEED)
})

test('reset via herstelkluis: nieuw wachtwoord werkt, herstelcode blijft, identiteit gelijk', { timeout: 60_000 }, async () => {
  const code = generateRecoveryCode()
  const doc = await signup({
    stores, seed: SEED, profile: { usersName: 'Frank', usersUid: 'frank' }, communityKey: key,
    auth: await createKeystore(SEED, PWD), recovery: await createKeystore(SEED, code),
  })
  // reset = herstelkluis openen → seed → nieuwe wachtwoord-keystore
  const seed = await openKeystore(doc.recovery, code)
  const updated = await rekeyAuth({ stores, seed, usersId: doc.usersId, newPassword: 'ResetPwd3#' })
  assert.equal(await openKeystore(updated.auth, 'ResetPwd3#'), SEED, 'nieuw wachtwoord ontsleutelt')
  await assert.rejects(() => openKeystore(updated.auth, PWD), /verkeerd wachtwoord/, 'oud wachtwoord faalt')
  assert.equal(await openKeystore(updated.recovery, code), SEED, 'herstelkluis blijft bruikbaar')
  assert.equal(updated.pubkey, doc.pubkey, 'identiteit ongewijzigd')
})
