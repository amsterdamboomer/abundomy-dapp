/**
 * Regressie: head-uitwisseling met MEER DAN ÉÉN head (patches/@orbitdb+core+4.0.0.patch).
 *
 * OrbitDB's sync.js doet één `stream.send()` per head, maar de libp2p-stream eronder is een
 * byte-stream zonder berichtgrenzen. Bij ≥2 heads komen die aaneengeplakt binnen en zag
 * `Entry.decode` twee CBOR-items achter elkaar → "too many terminals, data makes no sense".
 * De head-uitwisseling brak dan af en de store synchroniseerde niet meer (live gezien op de
 * `lists`-store: ~45.000 fouten in 2 weken, catch-up van lijsten stuk).
 *
 * Deze test dekt het contract van de patch: aaneengeplakte entry-bytes moeten weer exact in de
 * oorspronkelijke entries uiteenvallen. Dat is deterministisch te testen; het samenplakken zelf
 * gebeurt in de libp2p-transportlaag en is timingafhankelijk, dus dat bootsen we hier niet na.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { decodeFirst } from 'cborg'
import { decodeOptions } from '@ipld/dag-cbor'
import { Entry, Identities, KeyStore } from '@orbitdb/core'

/** Dezelfde splitsing als in de patch. */
const splitEntries = (bytes) => {
  const parts = []
  let rest = bytes
  while (rest.byteLength > 0) {
    const [, remainder] = decodeFirst(rest, decodeOptions)
    parts.push(rest.subarray(0, rest.byteLength - remainder.byteLength))
    rest = remainder
  }
  return parts
}

test('de patch zit in @orbitdb/core (postinstall)', () => {
  const sync = readFileSync(fileURLToPath(new URL('../node_modules/@orbitdb/core/src/sync.js', import.meta.url)), 'utf8')
  assert.ok(sync.includes('splitEntries'), 'sync.js is niet gepatcht — draai `npm install` (postinstall: patch-package)')
})

test('twee aaneengeplakte heads vallen weer exact uiteen', { timeout: 60_000 }, async () => {
  const keystore = await KeyStore()
  const identities = await Identities({ keystore })
  const identity = await identities.createIdentity({ id: 'sync-heads-test' })

  const entryA = await Entry.create(identity, 'log-1', { op: 'PUT', key: 1, value: 'a' })
  const entryB = await Entry.create(identity, 'log-1', { op: 'PUT', key: 2, value: 'b' })
  // sendHeads() verstuurt de OPGESLAGEN bytes van elke head; Entry.encode levert diezelfde bytes.
  const a = await Entry.encode(entryA)
  const b = await Entry.encode(entryB)

  const glued = new Uint8Array(a.bytes.byteLength + b.bytes.byteLength)
  glued.set(a.bytes, 0)
  glued.set(b.bytes, a.bytes.byteLength)

  // Zonder de splitsing (= oud gedrag) is dit precies de fout die live optrad.
  await assert.rejects(() => Entry.decode(glued), /too many terminals/)

  const parts = splitEntries(glued)
  assert.equal(parts.length, 2, 'twee entries verwacht')

  // Entry.decode hasht de bytes: gelijke hashes bewijzen dat de byte-grenzen exact kloppen.
  const [d1, d2] = await Promise.all(parts.map((p) => Entry.decode(p)))
  assert.equal(d1.hash, a.hash)
  assert.equal(d2.hash, b.hash)
  assert.deepEqual(d1.payload, entryA.payload)
  assert.deepEqual(d2.payload, entryB.payload)

  // Regressie: één losse entry moet blijven werken.
  assert.equal(splitEntries(a.bytes).length, 1)

  await keystore.close()
})
