/**
 * Fase 0 rookproef: bewijst dat Helia + OrbitDB v4 lokaal draaien op deze machine.
 *
 * Volledig in-memory: er wordt niets naar schijf geschreven (geen LevelDB op exFAT,
 * geen ._ bestanden). Persistente, exFAT-veilige opslag komt in Fase 1.
 */
import { createOrbitDB, Identities, KeyStore, MemoryStorage } from '@orbitdb/core'
import { createHeliaNode } from '../src/ipfs.mjs'

const log = (...a) => console.log('•', ...a)

let ipfs, orbitdb, db
try {
  log('Helia starten (in-memory, met pubsub)…')
  ipfs = await createHeliaNode()
  log('peerId:', ipfs.libp2p.peerId.toString())
  log('pubsub-service aanwezig:', !!ipfs.libp2p.services.pubsub)

  log('OrbitDB starten met in-memory keystore…')
  const keystore = await KeyStore({ storage: await MemoryStorage() })
  const identities = await Identities({ keystore, ipfs })
  orbitdb = await createOrbitDB({ ipfs, identities, id: 'smoke-node' })

  log('Database openen (events, in-memory storages)…')
  db = await orbitdb.open('abundomy-smoke', {
    type: 'events',
    entryStorage: await MemoryStorage(),
    headsStorage: await MemoryStorage(),
    indexStorage: await MemoryStorage(),
  })
  log('db.address:', db.address.toString())

  log('Schrijven…')
  await db.add({ msg: 'hallo abundomy', t: Date.now() })
  await db.add({ msg: 'tweede entry' })

  log('Teruglezen…')
  const all = await db.all()
  console.log(JSON.stringify(all.map((e) => e.value), null, 2))

  if (all.length !== 2) throw new Error(`verwacht 2 entries, kreeg ${all.length}`)
  console.log('\n✅ ROOKPROEF GESLAAGD — Helia + OrbitDB v4 werken lokaal.')
} catch (err) {
  console.error('\n❌ ROOKPROEF MISLUKT:', err)
  process.exitCode = 1
} finally {
  if (db) await db.close()
  if (orbitdb) await orbitdb.stop()
  if (ipfs) await ipfs.stop()
}
