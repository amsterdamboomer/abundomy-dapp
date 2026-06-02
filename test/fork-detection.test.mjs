/**
 * Fase 5: fork-detectie. Pure tests tegen de (lineaire) bron + een synthetische
 * fork (gever keurt twee betalingen goed tegen hetzelfde saldo).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseTable } from '../migration/parse-sql.mjs'
import { detectForks, detectAllForks } from '../src/fork-detection.mjs'
import { buildPaymentTx } from '../src/payments.mjs'
import { parseSqlDate } from '../src/ledger.mjs'

const sql = readFileSync(fileURLToPath(new URL('../../1CoinH_24_05_2026.sql', import.meta.url)), 'utf8')
const transactions = parseTable(sql, 'transactions').sort((a, b) => a.tid - b.tid)
const ASOF = parseSqlDate('2026-05-24 12:00:00')

test('gezonde (lineaire) keten: geen forks voor 13 en 14', () => {
  assert.equal(detectForks(transactions, 13).forked, false)
  assert.equal(detectForks(transactions, 14).forked, false)
})

test('hele dataset is fork-vrij', () => {
  assert.deepEqual(detectAllForks(transactions), [])
})

test('detecteert een double-spend: gever 13 betaalt twee keer tegen hetzelfde saldo', () => {
  // Twee concurrente betalingen vanaf dezelfde keten-staat van 13 (beide ankeren op
  // 13's laatste tx, tid 8) — zoals op twee replica's tegelijk zou gebeuren.
  const txA = buildPaymentTx({ proposal: { giver: 13, receiver: 14, amount: 5, description: 'A' }, allTxs: transactions, asOf: ASOF })
  const txB = buildPaymentTx({ proposal: { giver: 13, receiver: 15, amount: 7, description: 'B' }, allTxs: transactions, asOf: ASOF })
  txB.tid = txA.tid + 1 // distinct id; beide ankeren nog steeds op tid 8

  const forked = [...transactions, txA, txB]
  const res = detectForks(forked, 13)
  assert.equal(res.forked, true)
  assert.equal(res.conflicts.length, 1)
  assert.equal(res.conflicts[0].parentTid, 8) // beide kinderen van tid 8
  assert.deepEqual(res.conflicts[0].children, [txA.tid, txB.tid])
})

test('legitieme vervolgbetaling (lineair doorbouwen) is GEEN fork', () => {
  // txA bouwt op tid 8; txC bouwt op txA → lineair, geen vertakking.
  const txA = buildPaymentTx({ proposal: { giver: 13, receiver: 14, amount: 5, description: 'A' }, allTxs: transactions, asOf: ASOF })
  const txC = buildPaymentTx({ proposal: { giver: 13, receiver: 16, amount: 3, description: 'C' }, allTxs: [...transactions, txA], asOf: ASOF })
  const res = detectForks([...transactions, txA, txC], 13)
  assert.equal(res.forked, false)
})
