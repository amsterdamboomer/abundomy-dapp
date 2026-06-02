/**
 * Fase 4: black-/whitelist CRUD + betaal-toestemming. Integratie op een OrbitDB-node.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { startNode, stopNode } from '../src/orbit.mjs'
import { openStores, closeStores } from '../src/stores.mjs'
import { addToList, removeFromList, getList, isPaymentAllowed, BLACKLIST, WHITELIST } from '../src/lists.mjs'

const root = fileURLToPath(new URL('../.abundomy-poc/test-lists/', import.meta.url))
let node, stores

before(async () => {
  rmSync(root, { recursive: true, force: true })
  node = await startNode({ persist: true, id: 'lists-test', root })
  stores = await openStores(node.orbitdb, { write: ['*'] })
})
after(async () => {
  if (stores) await closeStores(stores)
  if (node) await stopNode(node)
})

test('toevoegen + ophalen, duplicaat genegeerd, verwijderen', { timeout: 60_000 }, async () => {
  await addToList({ stores, ownerId: 13, targetId: 18, listType: BLACKLIST })
  await addToList({ stores, ownerId: 13, targetId: 19, listType: BLACKLIST })
  const dup = await addToList({ stores, ownerId: 13, targetId: 18, listType: BLACKLIST })
  assert.equal(dup, null, 'duplicaat genegeerd')

  assert.deepEqual((await getList({ stores, ownerId: 13, listType: BLACKLIST })).sort(), [18, 19])

  assert.equal(await removeFromList({ stores, ownerId: 13, targetId: 18, listType: BLACKLIST }), true)
  assert.deepEqual(await getList({ stores, ownerId: 13, listType: BLACKLIST }), [19])
})

test('isPaymentAllowed: blacklist blokkeert, whitelist staat alleen toe', async () => {
  // Ontvanger 50 blokkeert gever 60 (blacklist-modus).
  await addToList({ stores, ownerId: 50, targetId: 60, listType: BLACKLIST })
  assert.equal(await isPaymentAllowed({ stores, giverId: 60, receiverId: 50, useWhitelist: 0 }), false)
  assert.equal(await isPaymentAllowed({ stores, giverId: 61, receiverId: 50, useWhitelist: 0 }), true)

  // Ontvanger 70 staat alleen gever 80 toe (whitelist-modus).
  await addToList({ stores, ownerId: 70, targetId: 80, listType: WHITELIST })
  assert.equal(await isPaymentAllowed({ stores, giverId: 80, receiverId: 70, useWhitelist: 1 }), true)
  assert.equal(await isPaymentAllowed({ stores, giverId: 81, receiverId: 70, useWhitelist: 1 }), false)
})
