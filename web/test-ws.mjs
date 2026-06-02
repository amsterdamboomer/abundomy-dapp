/**
 * Validatie (Node): repliceert het OrbitDB-verkeer over **WebSockets** — het
 * transport dat de browser-SPA gebruikt. Een relay-node luistert op tcp+ws; een
 * client-node met alléén het websockets-transport (zoals een browser) dialt de
 * relay en synct. Bewijst de transport-laag vóór we de SPA bouwen.
 */
import { rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { webSockets } from '@libp2p/websockets'
import { identify } from '@libp2p/identify'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { floodsub } from '@libp2p/floodsub'
import { generateKeyPairFromSeed } from '@libp2p/crypto/keys'
import { createHelia } from 'helia'
import { createOrbitDB } from '@orbitdb/core'
import { openStores, storeAddresses, closeStores } from '../src/stores.mjs'

const log = (...a) => console.log('•', ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const dir = (n) => fileURLToPath(new URL(`../.abundomy-poc/ws-${n}/`, import.meta.url))

async function mkNode({ seed, listen, transports }) {
  const privateKey = await generateKeyPairFromSeed('Ed25519', createHash('sha256').update(seed).digest())
  const libp2p = await createLibp2p({
    privateKey,
    addresses: { listen },
    transports,
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { identify: identify(), pubsub: floodsub({ emitSelf: true }) },
  })
  const ipfs = await createHelia({ libp2p }) // in-memory blockstore/datastore
  const orbitdb = await createOrbitDB({ ipfs, id: seed, directory: dir(seed) })
  return { ipfs, orbitdb }
}

for (const n of ['relay', 'client']) rmSync(dir(n), { recursive: true, force: true })

let relay, client
try {
  log('Relay starten (luistert op tcp + ws)…')
  relay = await mkNode({ seed: 'relay', listen: ['/ip4/127.0.0.1/tcp/0/ws', '/ip4/127.0.0.1/tcp/0'], transports: [tcp(), webSockets()] })
  const storesR = await openStores(relay.orbitdb, { write: ['*'] })
  const addresses = storeAddresses(storesR)
  await storesR.transactions.add({ tid: 1, giver: 14, receiver: 13, amount: 12, description: 'ws-test' })

  const wsAddr = relay.ipfs.libp2p.getMultiaddrs().find((m) => m.toString().includes('/ws'))
  log('relay ws-adres:', wsAddr.toString())

  log('Client starten (alléén websockets-transport, zoals de browser)…')
  client = await mkNode({ seed: 'client', listen: [], transports: [webSockets()] })
  await client.ipfs.libp2p.dial(wsAddr)
  const pubR = relay.ipfs.libp2p.services.pubsub, pubC = client.ipfs.libp2p.services.pubsub
  for (let i = 0; i < 100 && !(pubR.getPeers().some((p) => p.equals(client.ipfs.libp2p.peerId))); i++) await sleep(100)
  log('verbonden via ws; pubsub-peers OK')

  const storesC = await openStores(client.orbitdb, { write: ['*'] })
  if (storeAddresses(storesC).transactions !== addresses.transactions) throw new Error('adressen verschillen')

  log('Wachten tot client de transactie via ws ziet…')
  let seen = 0
  for (let i = 0; i < 160; i++) { seen = (await storesC.transactions.all()).length; if (seen >= 1) break; await sleep(250) }
  const tx = (await storesC.transactions.all()).map((e) => e.value)[0]
  log('client ziet:', JSON.stringify(tx ?? null))

  await closeStores(storesR); await closeStores(storesC)
  const ok = seen >= 1
  console.log(ok ? '\n✅ WS-REPLICATIE WERKT — browser-transport gevalideerd.' : '\n❌ WS-replicatie mislukt.')
  if (!ok) process.exitCode = 1
} catch (err) {
  console.error('\n❌ WS-TEST MISLUKT:', err)
  process.exitCode = 1
} finally {
  if (relay) { await relay.orbitdb.stop(); await relay.ipfs.stop() }
  if (client) { await client.orbitdb.stop(); await client.ipfs.stop() }
}
