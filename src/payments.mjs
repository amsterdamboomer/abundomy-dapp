/**
 * Betaal-/proposal-logica (Fase 3), 1-op-1 geport uit de legacy-PHP
 * (`includes/agree.inc.php` "pay" + `includes/receiver.inc.php` proposal-creatie),
 * gebouwd op `src/ledger.mjs` (hashes/saldo) en `src/stores.mjs` (OrbitDB).
 *
 * Legacy-flow: de **ontvanger** maakt een proposal; de **gever** bevestigt ("pay")
 * → saldo-check (decay-aware) → hashgiver/hashreceiver berekenen door op ieders
 * laatste transactie te ankeren → transactie toevoegen → proposal verwijderen.
 */
import { ZERO_HASH } from './config.mjs'
import { txHash, availableCoins, joinedDate } from './ledger.mjs'

/** Date → "YYYY-MM-DD HH:MM:SS" (UTC, past bij `parseSqlDate` in ledger.mjs). */
export function formatSqlDate(d) {
  return d.toISOString().slice(0, 19).replace('T', ' ')
}

/**
 * Het laatste (hashgiver,hashreceiver)-paar van een gebruiker uit de globale log
 * — legacy `getLastUserTransaction`: `WHERE giver=? OR receiver=? ORDER BY tid DESC
 * LIMIT 1`. Genesis (64×"0") als de gebruiker nog geen transactie heeft.
 */
export function getLastUserTransaction(allTxs, userId) {
  let last = null
  for (const tx of allTxs) {
    if ((tx.giver === userId || tx.receiver === userId) && (!last || tx.tid > last.tid)) last = tx
  }
  return last
    ? { hashgiver: last.hashgiver, hashreceiver: last.hashreceiver }
    : { hashgiver: ZERO_HASH, hashreceiver: ZERO_HASH }
}

/**
 * Bouw de nieuwe transactie (hashes + tid + timestamp) zoals agree.inc.php "pay".
 * De nieuwe tid = hoogste bestaande + 1 (de keten ankert op tid-volgorde), zodat
 * `replayChain` over alle transacties exact deze hashes reproduceert.
 */
export function buildPaymentTx({ proposal, allTxs, asOf }) {
  const time_stamp = formatSqlDate(asOf)
  const g = getLastUserTransaction(allTxs, proposal.giver)
  const r = getLastUserTransaction(allTxs, proposal.receiver)
  const base = {
    giver: proposal.giver, receiver: proposal.receiver, amount: proposal.amount,
    description: proposal.description, timestamp: time_stamp,
  }
  const hashgiver = txHash({ ...base, prevHashGiver: g.hashgiver, prevHashReceiver: g.hashreceiver })
  const hashreceiver = txHash({ ...base, prevHashGiver: r.hashgiver, prevHashReceiver: r.hashreceiver })
  const tid = allTxs.reduce((m, t) => Math.max(m, t.tid), 0) + 1
  return {
    tid, giver: proposal.giver, receiver: proposal.receiver, amount: proposal.amount,
    description: proposal.description, time_stamp, hashgiver, hashreceiver,
  }
}

/**
 * Proposal aanmaken (ontvanger-geïnitieerd). `hashgiver`/`hashreceiver` zijn — net
 * als legacy — de profiel-integriteitshashes van beide partijen, niet de keten.
 */
export async function createProposal({ stores, giver, receiver, amount, description, giverDoc, receiverDoc, asOf = new Date() }) {
  const pid = (await stores.proposals.all()).reduce((m, e) => Math.max(m, e.value.pid), 0) + 1
  const proposal = {
    pid, giver, receiver, amount, description,
    time_stamp: formatSqlDate(asOf),
    hashgiver: giverDoc?.hash ?? ZERO_HASH,
    hashreceiver: receiverDoc?.hash ?? ZERO_HASH,
  }
  await stores.proposals.put(proposal)
  return proposal
}

/**
 * Bevestig en voer een betaling uit (agree.inc.php action=pay). Decay-aware
 * saldo-check; bij onvoldoende saldo wordt de proposal verwijderd (legacy-rollback).
 * Grens `available == amount` is betaalbaar (legacy gebruikt `available < amount`).
 *
 * @param {{stores:object, proposal:object, usersOldRows?:Array, asOf?:Date}} args
 * @returns {Promise<{paid:boolean, reason?:string, tx?:object, available:number}>}
 */
export async function payProposal({ stores, proposal, usersOldRows = [], asOf = new Date() }) {
  const allTxs = (await stores.transactions.all()).map((e) => e.value)
  const giverDoc = (await stores.users.get(proposal.giver))?.value
  if (!giverDoc) return { paid: false, reason: 'giver_not_found', available: 0 }

  const available = availableCoins({
    joined: joinedDate(giverDoc, usersOldRows), transactions: allTxs, userId: proposal.giver, asOf,
  })
  if (available < proposal.amount) {
    await deleteProposalIfExists(stores, proposal.pid)
    return { paid: false, reason: 'insufficient_saldo', available }
  }

  const tx = buildPaymentTx({ proposal, allTxs, asOf })
  await stores.transactions.add(tx)
  await deleteProposalIfExists(stores, proposal.pid)
  return { paid: true, tx, available }
}

async function deleteProposalIfExists(stores, pid) {
  if (await stores.proposals.get(pid)) await stores.proposals.del(pid)
}
