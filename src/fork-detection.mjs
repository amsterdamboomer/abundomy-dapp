/**
 * Fork-detectie (Fase 5 — hardening). OrbitDB heeft geen consensus (eventual
 * consistency); het enige dat misgaat is een gever die op twee replica's tegelijk
 * twee betalingen goedkeurt tegen hetzelfde saldo → een "fork" van zijn eigen keten.
 *
 * Omdat deelnemers bekend/benoemd zijn en elke transactie de vorige (hashgiver,
 * hashreceiver) van die gebruiker als anker gebruikt, is een fork **bewijsbaar
 * detecteerbaar**: reconstrueer per gebruiker de keten als boom (elke tx wijst via
 * zijn hash naar zijn ouder-paar) en markeer elk knooppunt met meer dan één kind.
 *
 * Pure functies (txHash) → deterministisch te valideren.
 */
import { txHash } from './ledger.mjs'
import { ZERO_HASH } from './config.mjs'

/** De hash van de "eigen kant" van een tx voor `userId` (gever→hashgiver, ontvanger→hashreceiver). */
const sideHash = (tx, userId) => (tx.giver === userId ? tx.hashgiver : tx.hashreceiver)

/** Herbereken de eigen-kant-hash van `tx` alsof het vorige paar `prev` was. */
const recompute = (tx, prev) =>
  txHash({
    giver: tx.giver, receiver: tx.receiver, amount: tx.amount, description: tx.description,
    timestamp: tx.time_stamp, prevHashGiver: prev.hashgiver, prevHashReceiver: prev.hashreceiver,
  })

/**
 * Detecteer forks in de keten van één gebruiker.
 * @returns {{userId:number, forked:boolean, conflicts:Array<{parentTid:number, children:number[]}>, orphans:number[]}}
 */
export function detectForks(transactions, userId) {
  const mine = transactions.filter((t) => t.giver === userId || t.receiver === userId)
  const genesis = { tid: 0, hashgiver: ZERO_HASH, hashreceiver: ZERO_HASH }
  // Kandidaat-ouders: genesis + het resultaat-paar van elke transactie van deze gebruiker.
  const candidates = [genesis, ...mine.map((t) => ({ tid: t.tid, hashgiver: t.hashgiver, hashreceiver: t.hashreceiver }))]

  const childrenOf = new Map() // ouder-tid → [kind-tid]
  const orphans = []
  for (const tx of mine) {
    const stored = sideHash(tx, userId)
    const parent = candidates.find((c) => c.tid !== tx.tid && recompute(tx, c) === stored)
    if (!parent) { orphans.push(tx.tid); continue }
    if (!childrenOf.has(parent.tid)) childrenOf.set(parent.tid, [])
    childrenOf.get(parent.tid).push(tx.tid)
  }

  const conflicts = []
  for (const [parentTid, children] of childrenOf) {
    if (children.length > 1) conflicts.push({ parentTid, children: children.sort((a, b) => a - b) })
  }
  return { userId, forked: conflicts.length > 0, conflicts, orphans }
}

/** Scan álle gebruikers in de log en geef de forks terug (lege array = gezond). */
export function detectAllForks(transactions) {
  const userIds = new Set()
  for (const t of transactions) { userIds.add(t.giver); userIds.add(t.receiver) }
  const forks = []
  for (const userId of [...userIds].sort((a, b) => a - b)) {
    const r = detectForks(transactions, userId)
    if (r.forked) forks.push(r)
  }
  return forks
}
