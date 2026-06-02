/**
 * Fase 3 tests: de betaal-/proposal-logica. Pure tests draaien tegen de SQL-bron;
 * één integratietest draait payProposal op een echte (lokale) OrbitDB-node.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseTable } from '../migration/parse-sql.mjs'
import { replayChain, parseSqlDate } from '../src/ledger.mjs'
import { getLastUserTransaction, buildPaymentTx, createProposal, payProposal } from '../src/payments.mjs'
import { startNode, stopNode } from '../src/orbit.mjs'
import { openStores, closeStores } from '../src/stores.mjs'

const sql = readFileSync(fileURLToPath(new URL('../../1CoinH_24_05_2026.sql', import.meta.url)), 'utf8')
const transactions = parseTable(sql, 'transactions').sort((a, b) => a.tid - b.tid)

// ── Pure logica ────────────────────────────────────────────────────────────────

test('getLastUserTransaction: genesis voor onbekende gebruiker', () => {
  const pair = getLastUserTransaction(transactions, 9999)
  assert.equal(pair.hashgiver, '0'.repeat(64))
  assert.equal(pair.hashreceiver, '0'.repeat(64))
})

test('getLastUserTransaction: hoogste-tid paar voor gebruiker 13 (tid 8)', () => {
  const tid8 = transactions.find((t) => t.tid === 8)
  const pair = getLastUserTransaction(transactions, 13)
  assert.equal(pair.hashgiver, tid8.hashgiver)
  assert.equal(pair.hashreceiver, tid8.hashreceiver)
})

test('buildPaymentTx: nieuwe tx-hashes worden gereproduceerd door replayChain', () => {
  const proposal = { pid: 99, giver: 14, receiver: 13, amount: 50, description: 'PoC: lunch' }
  const asOf = parseSqlDate('2026-05-24 12:00:00')
  const tx = buildPaymentTx({ proposal, allTxs: transactions, asOf })
  assert.equal(tx.tid, 9) // hoogste bestaande (8) + 1

  const replayed = replayChain([...transactions, tx]).find((r) => r.tid === 9)
  assert.equal(replayed.hashgiver, tx.hashgiver)
  assert.equal(replayed.hashreceiver, tx.hashreceiver)
})

// ── Integratie: payProposal op een echte OrbitDB-node ───────────────────────────

test('payProposal: grens betaalbaar, daarna geweigerd + proposal verwijderd', { timeout: 60_000 }, async () => {
  const root = fileURLToPath(new URL('../.abundomy-poc/test-payments/', import.meta.url))
  rmSync(root, { recursive: true, force: true })
  const asOf = parseSqlDate('2026-01-01 00:00:00')
  let node
  try {
    node = await startNode({ persist: true, id: 'test-payments', root })
    const stores = await openStores(node.orbitdb, { write: ['*'] })
    // Gebruiker zonder historie → joined = start; op asOf=start is h=0 → owncoin = 1000.
    await stores.users.put({ usersId: 1000, start: '2026-01-01 00:00:00', hash: 'aa' })

    // Grens: amount == beschikbaar (1000) → betaalbaar.
    const p1 = await createProposal({ stores, giver: 1000, receiver: 1001, amount: 1000, description: 'grens', asOf })
    const r1 = await payProposal({ stores, proposal: p1, asOf })
    assert.equal(r1.paid, true)
    assert.equal(r1.tx.tid, 1)
    assert.equal((await stores.transactions.all()).length, 1)
    assert.equal(await stores.proposals.get(p1.pid), undefined) // verwijderd

    // Nu is het saldo 0 → een tweede betaling wordt geweigerd én de proposal opgeruimd.
    const p2 = await createProposal({ stores, giver: 1000, receiver: 1001, amount: 2000, description: 'te veel', asOf })
    const r2 = await payProposal({ stores, proposal: p2, asOf })
    assert.equal(r2.paid, false)
    assert.equal(r2.reason, 'insufficient_saldo')
    assert.equal((await stores.transactions.all()).length, 1) // geen extra tx
    assert.equal(await stores.proposals.get(p2.pid), undefined) // opgeruimd

    await closeStores(stores)
  } finally {
    if (node) await stopNode(node)
  }
})
