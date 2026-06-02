/**
 * Ledger-kern (Fase 2): de hash-keten en de decay/UBI-saldoberekening van `1CoinH`,
 * 1-op-1 geport uit `includes/agree.inc.php` + `includes/functions.inc.php`.
 *
 * Pure functies, geen IPFS/OrbitDB — zo zijn ze deterministisch te valideren
 * tegen de gemigreerde brondata (zie `test/ledger.test.mjs`).
 */
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import { DECAY_RATE, INCOME_PER_HOUR, ZERO_HASH } from './config.mjs'

// Portable sha256 (Node + browser); byte-identiek aan de PHP/legacy hashes.
const sha256hex = (s) => bytesToHex(sha256(utf8ToBytes(s)))

/**
 * PHP doet `(float)$amount` en plakt dat als string aan de hash-input. Voor de
 * bedragen in deze dataset (gehele getallen en 2 decimalen) is `String(n)`
 * byte-identiek aan PHP's float→string. Geverifieerd tegen de opgeslagen hashes.
 */
export const phpFloat = (n) => String(n)

/** Eén transactie-hash: sha256 van de PHP-concatenatie (UTF-8, geen scheidingstekens). */
export function txHash({ giver, receiver, amount, description, timestamp, prevHashGiver, prevHashReceiver }) {
  const data =
    String(giver) + String(receiver) + phpFloat(amount) + String(description) +
    String(timestamp) + String(prevHashGiver) + String(prevHashReceiver)
  return sha256hex(data)
}

/**
 * Speel de keten af. Transactions MOETEN op tid oplopend staan (de keten ankert
 * via `getLastUserTransaction` op de laatste tx — `ORDER BY tid DESC LIMIT 1` —
 * van zowel gever als ontvanger). Gever en ontvanger berekenen elk hun eigen hash
 * met hún eigen vorige (hashgiver,hashreceiver)-paar; ná de tx krijgen beiden het
 * nieuwe paar als hun "laatste".
 *
 * @param {Array<{tid:number,giver:number,receiver:number,amount:number,description:string,time_stamp:string}>} transactions
 * @returns {Array<{tid:number,hashgiver:string,hashreceiver:string}>}
 */
export function replayChain(transactions) {
  const lastByUser = new Map() // userId → { hashgiver, hashreceiver }
  const genesis = { hashgiver: ZERO_HASH, hashreceiver: ZERO_HASH }
  const out = []

  for (const tx of transactions) {
    const g = lastByUser.get(tx.giver) ?? genesis
    const r = lastByUser.get(tx.receiver) ?? genesis
    const base = {
      giver: tx.giver, receiver: tx.receiver, amount: tx.amount,
      description: tx.description, timestamp: tx.time_stamp,
    }
    const hashgiver = txHash({ ...base, prevHashGiver: g.hashgiver, prevHashReceiver: g.hashreceiver })
    const hashreceiver = txHash({ ...base, prevHashGiver: r.hashgiver, prevHashReceiver: r.hashreceiver })

    const pair = { hashgiver, hashreceiver }
    lastByUser.set(tx.giver, pair)
    lastByUser.set(tx.receiver, pair)
    out.push({ tid: tx.tid, hashgiver, hashreceiver })
  }
  return out
}

/** "YYYY-MM-DD HH:MM:SS" → Date (als UTC, voor deterministische uren-diff). */
export function parseSqlDate(s) {
  return new Date(s.replace(' ', 'T') + 'Z')
}

/**
 * Hele uren tussen twee momenten, zoals PHP `$a->diff($b)` → `days*24 + h`.
 * Dat is gelijk aan floor(|Δ| / 1 uur), want days = volle dagen en h = restuur.
 */
export function hoursBetween(from, to) {
  return Math.floor(Math.abs(to.getTime() - from.getTime()) / 3_600_000)
}

/**
 * Eigen-startdatum van een gebruiker zoals `getUserData`: de vroegste `start_old`
 * uit `users_old` (profielhistorie), of anders de huidige `users.start`.
 * Lexicografische min op "YYYY-MM-DD HH:MM:SS" = chronologische min.
 */
export function joinedDate(user, usersOldRows = []) {
  let min = null
  for (const o of usersOldRows) {
    if (o.uid_old === user.usersId && (min === null || o.start_old < min)) min = o.start_old
  }
  return min ?? user.start
}

/**
 * Beschikbaar saldo (decay + basisinkomen + verrekende transacties), 1-op-1 uit
 * `calculateAvailableCoins`. Tijdsafhankelijk → `asOf` expliciet i.p.v. `now()`
 * voor deterministische tests.
 *
 * owncoin = 1000·r^h + (1−r^h)/(1−r)  met r=DECAY_RATE, h=uren sinds `joined`
 *           (1000 = afnemende startgift; de reeks = 1 munt/uur basisinkomen → ~20.000).
 * Elke transactie: amount·r^(uren sinds tx), opgeteld bij ontvangst, afgetrokken bij uitgave.
 *
 * @param {{joined:string, transactions:Array, userId:number, asOf:Date}} args
 */
export function availableCoins({ joined, transactions, userId, asOf }) {
  const r = DECAY_RATE
  const h = hoursBetween(parseSqlDate(joined), asOf)
  const powN = Math.pow(r, h)
  const owncoin = 1000 * powN + (INCOME_PER_HOUR * (1 - powN)) / (1 - r)

  let spent = 0
  let received = 0
  for (const tx of transactions) {
    if (tx.giver !== userId && tx.receiver !== userId) continue
    const decay = tx.amount * Math.pow(r, hoursBetween(parseSqlDate(tx.time_stamp), asOf))
    if (tx.giver === userId) spent += decay
    else received += decay
  }
  return owncoin + received - spent
}
