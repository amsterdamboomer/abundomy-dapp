/**
 * Fase 2 integratie: laad de transacties uit de GEMIGREERDE OrbitDB-store en
 * bewijs dat de ledger-replay de daar opgeslagen hashes reproduceert. Sluit de
 * cirkel Fase 1 (migratie) → Fase 2 (port) end-to-end.
 *
 * Vereist dat `npm run migrate` heeft gedraaid (.abundomy-data/ bestaat).
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startNode, stopNode } from '../src/orbit.mjs'
import { openStores, closeStores } from '../src/stores.mjs'
import { replayChain } from '../src/ledger.mjs'

let node
let stores

before(async () => {
  node = await startNode({ persist: true })
  stores = await openStores(node.orbitdb)
})

after(async () => {
  if (stores) await closeStores(stores)
  if (node) await stopNode(node)
})

test('gemigreerde transactie-store reproduceert haar eigen hashes', { timeout: 60_000 }, async () => {
  const entries = await stores.transactions.all()
  const txs = entries.map((e) => e.value).sort((a, b) => a.tid - b.tid)
  assert.ok(txs.length > 0, 'store is leeg — draai eerst `npm run migrate`')
  assert.equal(txs.length, 6)

  const replay = replayChain(txs)
  const byTid = new Map(replay.map((r) => [r.tid, r]))
  for (const tx of txs) {
    const got = byTid.get(tx.tid)
    assert.equal(got.hashgiver, tx.hashgiver, `tid ${tx.tid} hashgiver`)
    assert.equal(got.hashreceiver, tx.hashreceiver, `tid ${tx.tid} hashreceiver`)
  }
})
