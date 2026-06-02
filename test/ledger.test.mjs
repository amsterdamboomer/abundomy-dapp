/**
 * Fase 2 validatie (pure, geen IPFS): bewijst dat de JS-ledger identieke hashes
 * en consistente saldi oplevert t.o.v. de gemigreerde brondata. Draait via
 * `npm test` (node:test, geen extra dependency).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseTable } from '../migration/parse-sql.mjs'
import { replayChain, availableCoins, joinedDate, parseSqlDate } from '../src/ledger.mjs'
import { DECAY_RATE } from '../src/config.mjs'

const sql = readFileSync(fileURLToPath(new URL('../../1CoinH_24_05_2026.sql', import.meta.url)), 'utf8')
const transactions = parseTable(sql, 'transactions').sort((a, b) => a.tid - b.tid)
const users = parseTable(sql, 'users')
const usersOld = parseTable(sql, 'users_old')

// Vast referentiemoment (de dump-datum) zodat saldi deterministisch zijn.
const ASOF = parseSqlDate('2026-05-24 00:00:00')

// ── Hash-keten: harde go/no-go tegen de opgeslagen hashes ──────────────────────

test('replay reproduceert elke opgeslagen hashgiver/hashreceiver', () => {
  const replay = replayChain(transactions)
  const byTid = new Map(replay.map((r) => [r.tid, r]))
  assert.equal(replay.length, transactions.length)

  for (const tx of transactions) {
    const got = byTid.get(tx.tid)
    assert.equal(got.hashgiver, tx.hashgiver, `tid ${tx.tid} hashgiver`)
    assert.equal(got.hashreceiver, tx.hashreceiver, `tid ${tx.tid} hashreceiver`)
  }
})

test('tid 8 heeft verschillende gever-/ontvangerhash (verschillende ketenkoppen)', () => {
  const r8 = replayChain(transactions).find((r) => r.tid === 8)
  assert.notEqual(r8.hashgiver, r8.hashreceiver)
})

// ── Saldo: deterministische invarianten (geen opgeslagen ground truth) ─────────

test('owncoin op h=0 is exact 1000 (startgift, nog niet vervallen)', () => {
  const u = users.find((x) => x.usersId === 15) // geen transacties
  const balance = availableCoins({
    joined: joinedDate(u, usersOld), transactions, userId: 15,
    asOf: parseSqlDate(joinedDate(u, usersOld)), // asOf == joined → h=0
  })
  assert.equal(balance, 1000)
})

test('UBI-reeks: gesloten vorm == iteratieve som (1-r^h)/(1-r)', () => {
  const r = DECAY_RATE
  for (const h of [1, 24, 1000]) {
    let iter = 0
    for (let k = 0; k < h; k++) iter += Math.pow(r, k)
    const closed = (1 - Math.pow(r, h)) / (1 - r)
    assert.ok(Math.abs(iter - closed) < 1e-6, `h=${h}: ${iter} vs ${closed}`)
  }
})

test('owncoin convergeert naar ~20.000 op lange termijn', () => {
  const farFuture = new Date(ASOF.getTime() + 50 * 365 * 24 * 3_600_000) // ~50 jaar
  const u = users.find((x) => x.usersId === 15)
  const balance = availableCoins({ joined: u.start, transactions, userId: 15, asOf: farFuture })
  assert.ok(Math.abs(balance - 20000) < 1, `kreeg ${balance}`)
})

test('behoudswet: Σ saldi == Σ owncoins (transactie-decay valt globaal weg)', () => {
  // Elke tx telt dezelfde vervallen waarde op bij de ontvanger én eraf bij de
  // gever → globaal nul. Som van alle saldi == som van alle owncoins.
  const r = DECAY_RATE
  let sumBalances = 0
  let sumOwncoin = 0
  for (const u of users) {
    const joined = joinedDate(u, usersOld)
    sumBalances += availableCoins({ joined, transactions, userId: u.usersId, asOf: ASOF })
    const h = Math.floor((ASOF.getTime() - parseSqlDate(joined).getTime()) / 3_600_000)
    sumOwncoin += 1000 * Math.pow(r, h) + (1 - Math.pow(r, h)) / (1 - r)
  }
  assert.ok(Math.abs(sumBalances - sumOwncoin) < 1e-6, `${sumBalances} vs ${sumOwncoin}`)
})

test('saldo gever 13 = owncoin + ontvangen − uitgegeven (handmatig nagerekend)', () => {
  const r = DECAY_RATE
  const u = users.find((x) => x.usersId === 13)
  const joined = joinedDate(u, usersOld)
  const h = Math.floor((ASOF.getTime() - parseSqlDate(joined).getTime()) / 3_600_000)
  const owncoin = 1000 * Math.pow(r, h) + (1 - Math.pow(r, h)) / (1 - r)
  let manual = owncoin
  for (const tx of transactions) {
    if (tx.giver !== 13 && tx.receiver !== 13) continue
    const th = Math.floor((ASOF.getTime() - parseSqlDate(tx.time_stamp).getTime()) / 3_600_000)
    const decay = tx.amount * Math.pow(r, th)
    manual += tx.giver === 13 ? -decay : decay
  }
  const got = availableCoins({ joined, transactions, userId: 13, asOf: ASOF })
  assert.ok(Math.abs(got - manual) < 1e-9, `${got} vs ${manual}`)
})
