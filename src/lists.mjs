/**
 * Black-/whitelist (Fase 4), 1-op-1 met legacy `includes/list-handler.inc.php`.
 * listType: **0 = blacklist (blokkeren)**, **1 = whitelist (toestaan)**.
 * De `useWhitelist`-vlag op het user-doc bepaalt welke lijst actief is.
 */
export const BLACKLIST = 0
export const WHITELIST = 1

const entries = async (stores) => (await stores.lists.all()).map((e) => e.value)

/** Voeg toe (idempotent, net als legacy `INSERT IGNORE`). */
export async function addToList({ stores, ownerId, targetId, listType }) {
  const all = await entries(stores)
  if (all.some((v) => v.ownerId === ownerId && v.targetId === targetId && v.listType === listType)) return null
  const listId = all.reduce((m, v) => Math.max(m, v.listId), 0) + 1
  const entry = { listId, ownerId, targetId, listType }
  await stores.lists.put(entry)
  return entry
}

/** Verwijder een lijstvermelding. @returns true als er iets verwijderd is. */
export async function removeFromList({ stores, ownerId, targetId, listType }) {
  const match = (await entries(stores)).find(
    (v) => v.ownerId === ownerId && v.targetId === targetId && v.listType === listType,
  )
  if (match) await stores.lists.del(match.listId)
  return !!match
}

/** Alle targetId's op de gegeven lijst van een eigenaar. */
export async function getList({ stores, ownerId, listType }) {
  return (await entries(stores))
    .filter((v) => v.ownerId === ownerId && v.listType === listType)
    .map((v) => v.targetId)
}

/**
 * Mag `giverId` aan `receiverId` betalen volgens de lijsten van de ontvanger?
 * - whitelist actief: alleen als gever op de whitelist staat.
 * - anders (blacklist): geblokkeerd als gever op de blacklist staat.
 */
export async function isPaymentAllowed({ stores, giverId, receiverId, useWhitelist }) {
  if (useWhitelist) {
    return (await getList({ stores, ownerId: receiverId, listType: WHITELIST })).includes(giverId)
  }
  return !(await getList({ stores, ownerId: receiverId, listType: BLACKLIST })).includes(giverId)
}
