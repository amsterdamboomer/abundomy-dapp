/**
 * Fase 4: draagbare, zelf-verifieerbare keten-export. Pure tests tegen de SQL-bron
 * + één integratietest die exporteert vanuit een echte (versleutelde) store.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseTable } from '../migration/parse-sql.mjs'
import { verifyUserChain, csvRow, parseExportCsv, verifyExportedChain, exportUserChain } from '../src/export.mjs'
import { startNode, stopNode } from '../src/orbit.mjs'
import { openStores, closeStores } from '../src/stores.mjs'
import { deriveCommunityKey } from '../src/crypto.mjs'

const sql = readFileSync(fileURLToPath(new URL('../../1CoinH_24_05_2026.sql', import.meta.url)), 'utf8')
const transactions = parseTable(sql, 'transactions')

test('verifyUserChain: geldige keten voor gebruiker 13 (6 tx) en 14 (5 tx)', () => {
  // 13 zit in tid 3-8 (6×); 14 in tid 3-7 (5×, niet in tid 8 = 18→13).
  assert.deepEqual(verifyUserChain(transactions, 13), { valid: true, checked: 6 })
  assert.deepEqual(verifyUserChain(transactions, 14), { valid: true, checked: 5 })
})

test('verifyUserChain: detecteert manipulatie', () => {
  const tampered = transactions.map((t) => (t.tid === 5 ? { ...t, hashreceiver: 'f'.repeat(64) } : t))
  const res = verifyUserChain(tampered, 13)
  assert.equal(res.valid, false)
  assert.equal(res.failedTid, 5)
})

test('CSV round-trip: export → parse → verify (gebruiker 13)', () => {
  const mine = transactions.filter((t) => t.giver === 13 || t.receiver === 13)
  let csv = csvRow(['A', '2026-05-24 12:00:00', 13])
  csv += csvRow(['C', 'Teun', '-', '1965-02-13', 0, '1.80m', 12, 8, 8, 'Scar', '2026-05-06 04:52:12', '0'.repeat(64), 'aa'])
  for (const t of mine) csv += csvRow(['D', t.tid, t.giver, t.receiver, t.amount, t.description, t.time_stamp, t.hashgiver, t.hashreceiver])

  const parsed = parseExportCsv(csv)
  assert.equal(parsed.userId, 13)
  assert.equal(parsed.profile.usersName, 'Teun')
  assert.equal(parsed.transactions.length, 6)
  assert.deepEqual(verifyExportedChain(csv), { valid: true, checked: 6 })
})

test('integratie: export vanuit versleutelde store, profiel ontsleuteld + keten geldig', { timeout: 60_000 }, async () => {
  const root = fileURLToPath(new URL('../.abundomy-poc/test-export/', import.meta.url))
  rmSync(root, { recursive: true, force: true })
  let node
  try {
    node = await startNode({ persist: true, id: 'export-test', root })
    const stores = await openStores(node.orbitdb, { write: ['*'] })
    const key = await deriveCommunityKey('test-secret')
    const { encryptUserProfile } = await import('../src/crypto.mjs')
    await stores.users.put(await encryptUserProfile(
      { usersId: 13, usersName: 'Teun', start: '2026-05-06 04:52:12', lastHash: '0'.repeat(64),
        hash: 'aa', height: '1.80m', specialFeatures: 'Scar under left eye' }, key))
    for (const t of transactions) await stores.transactions.add(t)

    const csv = await exportUserChain({ stores, userId: 13, communityKey: key, asOf: new Date('2026-05-24T12:00:00Z') })
    assert.match(csv, /^"A", "2026-05-24 12:00:00", "13";/)            // meta-rij
    assert.ok(csv.includes('Scar under left eye'), 'profiel ontsleuteld in C-rij')
    assert.deepEqual(verifyExportedChain(csv), { valid: true, checked: 6 })

    await closeStores(stores)
  } finally {
    if (node) await stopNode(node)
  }
})
