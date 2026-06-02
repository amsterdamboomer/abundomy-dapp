/**
 * Schrijf een geparste SQL-dump in de OrbitDB-stores. Gedeeld door `migrate.mjs`
 * (Fase 1) en de PoC-seeding (Fase 3).
 *
 * Idempotent: slaat schrijven over als er al data staat (append-only log mag niet
 * dubbel). `usersPwd` wordt weggelaten (auth via sleutelpaar). Als `communityKey`
 * is meegegeven (Fase 4) worden gevoelige profielvelden client-side versleuteld
 * vóór opslag. `users_old` wordt slank gemigreerd (alleen wat `joined` nodig heeft).
 */
import { parseDump } from './parse-sql.mjs'
import { encryptUserProfile } from '../src/crypto.mjs'

export async function importDump(stores, sql, { communityKey } = {}) {
  const data = parseDump(sql)
  data.transactions.sort((a, b) => a.tid - b.tid) // grootboek-volgorde = tid oplopend

  const existing =
    (await stores.transactions.all()).length +
    (await stores.users.all()).length +
    (await stores.proposals.all()).length +
    (await stores.lists.all()).length +
    (await stores.usersOld.all()).length

  if (existing === 0) {
    for (const tx of data.transactions) await stores.transactions.add(tx)
    for (const u of data.users) {
      const { usersPwd, ...profile } = u
      const doc = communityKey ? await encryptUserProfile(profile, communityKey) : profile
      await stores.users.put(doc)
    }
    for (const p of data.proposals) await stores.proposals.put(p)
    for (const l of data.lists) await stores.lists.put(l)
    // Slank: alleen de velden die `joined` (= MIN(start_old)) nodig heeft.
    for (const o of data.usersOld) {
      await stores.usersOld.put({ usersOldId: o.usersOldId, uid_old: o.uid_old, start_old: o.start_old })
    }
  }

  return {
    skipped: existing > 0,
    expected: {
      transactions: data.transactions.length,
      users: data.users.length,
      proposals: data.proposals.length,
      lists: data.lists.length,
      usersOld: data.usersOld.length,
    },
  }
}

/** Tel de records per store (voor verificatie). */
export async function countStores(stores) {
  return {
    transactions: (await stores.transactions.all()).length,
    users: (await stores.users.all()).length,
    proposals: (await stores.proposals.all()).length,
    lists: (await stores.lists.all()).length,
    usersOld: (await stores.usersOld.all()).length,
  }
}

/** Laad de users_old-rijen uit de store (vervangt de SQL-dump bij saldoberekening). */
export async function loadUsersOld(stores) {
  return (await stores.usersOld.all()).map((e) => e.value)
}
