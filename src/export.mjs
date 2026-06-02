/**
 * Draagbare, zelf-verifieerbare export van een gebruikersketen (Fase 4),
 * gebaseerd op legacy `download-csv.php` (rij-tags A/B/C/D, formaat
 * `"f1", "f2", …;\r\n`).
 *
 * Winst t.o.v. legacy: de export is **zelf-verifieerbaar**. Met alleen de eigen
 * transacties kan iedereen de keten herrekenen (`verifyUserChain`) — elke tx-hash
 * ankert op het vorige (hashgiver,hashreceiver)-paar van die gebruiker. Zo bewijst
 * de export dat de keten niet is gemanipuleerd, zónder server.
 *
 * B-sectie (historische profielen) ontbreekt: `users_old` is slank gemigreerd
 * (alleen joined-velden). A = meta, C = huidig (ontsleuteld) profiel, D = transacties.
 */
import { txHash } from './ledger.mjs'
import { ZERO_HASH } from './config.mjs'
import { decryptUserProfile } from './crypto.mjs'
import { formatSqlDate } from './payments.mjs'

/** Verwijder regeleindes (mogen het CSV-formaat niet breken). */
export const cleanForCsv = (s) => (s == null ? '' : String(s).replace(/[\r\n]+/g, ' '))

const field = (f) => {
  const v = f === null || f === undefined || f === '' ? '-' : String(f)
  return `"${v.replace(/"/g, '""')}"`
}

/** Eén rij in het legacy-formaat: `"f1", "f2", …;\r\n`. */
export const csvRow = (fields) => `${fields.map(field).join(', ')};\r\n`

/** Exporteer profiel + keten van één gebruiker als CSV-string. */
export async function exportUserChain({ stores, userId, communityKey, asOf = new Date() }) {
  const userDoc = (await stores.users.get(userId))?.value
  if (!userDoc) throw new Error(`user ${userId} niet gevonden`)
  const p = await decryptUserProfile(userDoc, communityKey)
  const txs = (await stores.transactions.all())
    .map((e) => e.value)
    .filter((t) => t.giver === userId || t.receiver === userId)
    .sort((a, b) => a.tid - b.tid)

  let csv = csvRow(['A', formatSqlDate(asOf), userId])
  csv += csvRow(['C', p.usersName, p.image, p.birthday, p.gender, p.height, p.hair,
    p.leftEye, p.rightEye, cleanForCsv(p.specialFeatures), p.start, p.lastHash, p.hash])
  for (const t of txs) {
    csv += csvRow(['D', t.tid, t.giver, t.receiver, t.amount, cleanForCsv(t.description),
      t.time_stamp, t.hashgiver, t.hashreceiver])
  }
  return csv
}

/**
 * Verifieer de hash-keten van één gebruiker uit transactie-objecten (lossless).
 * Per tx wordt de hash van *de eigen kant* herrekend uit het vorige paar.
 */
export function verifyUserChain(transactions, userId) {
  const mine = transactions
    .filter((t) => t.giver === userId || t.receiver === userId)
    .sort((a, b) => a.tid - b.tid)
  let prev = { hashgiver: ZERO_HASH, hashreceiver: ZERO_HASH }
  for (const t of mine) {
    const h = txHash({
      giver: t.giver, receiver: t.receiver, amount: t.amount, description: t.description,
      timestamp: t.time_stamp, prevHashGiver: prev.hashgiver, prevHashReceiver: prev.hashreceiver,
    })
    const expected = t.giver === userId ? t.hashgiver : t.hashreceiver
    if (h !== expected) return { valid: false, failedTid: t.tid, checked: mine.length }
    prev = { hashgiver: t.hashgiver, hashreceiver: t.hashreceiver }
  }
  return { valid: true, checked: mine.length }
}

/** Parse een export-CSV terug naar `{ exportedAt, userId, profile, transactions }`. */
export function parseExportCsv(csv) {
  const out = { transactions: [] }
  for (const line of csv.split('\r\n')) {
    if (!line) continue
    const fields = [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1].replace(/""/g, '"'))
    const [tag, ...rest] = fields
    if (tag === 'A') { out.exportedAt = rest[0]; out.userId = Number(rest[1]) }
    else if (tag === 'C') {
      out.profile = {
        usersName: rest[0], image: rest[1], birthday: rest[2], gender: rest[3], height: rest[4],
        hair: rest[5], leftEye: rest[6], rightEye: rest[7], specialFeatures: rest[8],
        start: rest[9], lastHash: rest[10], hash: rest[11],
      }
    } else if (tag === 'D') {
      out.transactions.push({
        tid: Number(rest[0]), giver: Number(rest[1]), receiver: Number(rest[2]),
        amount: Number(rest[3]), description: rest[4], time_stamp: rest[5],
        hashgiver: rest[6], hashreceiver: rest[7],
      })
    }
  }
  return out
}

/** Parse + verifieer een export-CSV in één keer. */
export function verifyExportedChain(csv) {
  const { userId, transactions } = parseExportCsv(csv)
  return verifyUserChain(transactions, userId)
}
