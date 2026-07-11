/**
 * De vier Abundomy-stores die MySQL vervangen (zie PLAN.md §3).
 *
 * - `transactions`  → één globale **events**-log = de grootboek-tabel 1-op-1.
 *   Bewust globaal (niet per gebruiker): de hash-keten ankert op de laatste
 *   transactie van een gebruiker via `ORDER BY tid` (zie legacy
 *   `getLastUserTransaction`), dus de globale tid-volgorde moet bewaard blijven.
 *   Een gebruikersketen is een *afgeleide view* (`giver==id || receiver==id`).
 * - `users` / `proposals` / `lists` → **documents**, gesleuteld op hun id.
 */
import { Documents, IPFSAccessController } from '@orbitdb/core'

export const DB_NAMES = {
  transactions: 'abundomy-transactions',
  users: 'abundomy-users',
  proposals: 'abundomy-proposals',
  lists: 'abundomy-lists',
  usersOld: 'abundomy-users-old',
}

/** De per-store index/type-config (ook nodig bij openen-op-adres: `indexBy` zit
 *  NIET in de manifest, dus die moet altijd mee). */
const STORE_OPTS = {
  transactions: { type: 'events' },
  users: { Database: Documents({ indexBy: 'usersId' }) },
  proposals: { Database: Documents({ indexBy: 'pid' }) },
  lists: { Database: Documents({ indexBy: 'listId' }) },
  usersOld: { Database: Documents({ indexBy: 'usersOldId' }) },
}

/**
 * Open de vier stores.
 * @param {object} orbitdb
 * @param {{write?: string[], addresses?: Record<string,string>}} [opts]
 *   - `write`: schrijfrechten (bv. `['*']` voor multi-peer in de PoC). Wordt
 *     genegeerd bij openen-op-adres (de ACL komt dan uit de manifest).
 *   - `addresses`: open elke store op dit `/orbitdb/...`-adres i.p.v. op naam
 *     (peer B in de PoC opent zo exact dezelfde databases als peer A).
 */
export async function openStores(orbitdb, { write, addresses } = {}) {
  const acOpt = write ? { AccessController: IPFSAccessController({ write }) } : {}
  const open = async (key) => {
    const target = addresses?.[key] ?? DB_NAMES[key]
    // sync:true is vereist — OrbitDB's `syncAutomatically` default is feitelijk
    // false (geen default in de destructuring), dus zonder dit start de Sync niet
    // en repliceert niets. Op naam → maak/gebruik ACL; op adres → ACL uit manifest.
    const db = await orbitdb.open(target, { sync: true, ...STORE_OPTS[key], ...(addresses ? {} : acOpt) })
    // KRITIEK: een peer die een onleesbare/corrupte head-entry stuurt laat OrbitDB-sync
    // een 'error'-event emitten (sync.js `handleReceiveHeads` → bv. CBOR-decodefout).
    // `db.events` is dezelfde emitter die Sync gebruikt; zónder listener is dat een
    // onafgevangen 'error' → Node beëindigt het hele proces. De anker-replicator
    // crash-loopte hierdoor ~1×/min (login-uitval voor iedereen). Een listener maakt
    // het non-fataal: log en negeer; die ene peer wordt overgeslagen, de store draait door.
    db.events.on('error', (e) => console.warn(`⚠ sync-fout in store '${key}' (genegeerd): ${e?.message || e}`))
    return db
  }
  const transactions = await open('transactions')
  const users = await open('users')
  const proposals = await open('proposals')
  const lists = await open('lists')
  const usersOld = await open('usersOld')
  return { transactions, users, proposals, lists, usersOld }
}

/** Map van store → `/orbitdb/...`-adres (door te geven aan een tweede peer). */
export function storeAddresses(stores) {
  return Object.fromEntries(
    Object.entries(stores).map(([k, db]) => [k, db.address.toString()]),
  )
}

export async function closeStores(stores) {
  for (const db of Object.values(stores)) await db.close()
}
