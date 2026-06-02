/**
 * Browser-variant van de Helia/libp2p-node voor de SPA.
 *
 * - Transport: WebSockets (dial naar de relay) + WebRTC + circuit-relay (browser↔
 *   browser via de relay). Browsers kunnen niet beluisteren, dus alleen dialen.
 * - Opslag: IndexedDB (blockstore-idb / datastore-idb) i.p.v. het bestandssysteem.
 * - Identiteit: deterministische Ed25519-sleutel uit de seed (zelfde seed = zelfde
 *   peerId + OrbitDB-identiteit).
 */
import { createLibp2p } from 'libp2p'
import { webSockets } from '@libp2p/websockets'
import { webRTC } from '@libp2p/webrtc'
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2'
import { identify } from '@libp2p/identify'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { floodsub } from '@libp2p/floodsub'
import { generateKeyPairFromSeed } from '@libp2p/crypto/keys'
import { sha256 } from '@noble/hashes/sha2.js'
import { utf8ToBytes } from '@noble/hashes/utils.js'
import { createHelia } from 'helia'
import { bitswap } from '@helia/block-brokers'
import { IDBBlockstore } from 'blockstore-idb'
import { IDBDatastore } from 'datastore-idb'
import { createOrbitDB } from '@orbitdb/core'

export async function startBrowserNode({ seed }) {
  const privateKey = await generateKeyPairFromSeed('Ed25519', sha256(utf8ToBytes(seed)))
  const libp2p = await createLibp2p({
    privateKey,
    addresses: { listen: ['/webrtc'] },
    transports: [webSockets(), webRTC(), circuitRelayTransport()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    connectionGater: { denyDialMultiaddr: () => false }, // localhost in dev toestaan
    services: { identify: identify(), pubsub: floodsub({ emitSelf: true }) },
  })

  const blockstore = new IDBBlockstore(`abundomy-blocks-${seed}`)
  const datastore = new IDBDatastore(`abundomy-data-${seed}`)
  await blockstore.open()
  await datastore.open()

  // Volledig IPFS-onafhankelijk: alleen p2p-bitswap (blocks komen via de relay),
  // géén externe trustless-gateways en géén delegated routing (delegated-ipfs.dev).
  const ipfs = await createHelia({ libp2p, blockstore, datastore, blockBrokers: [bitswap()], routers: [] })
  const orbitdb = await createOrbitDB({ ipfs, id: seed, directory: `abundomy-orbitdb-${seed}` })
  return { ipfs, orbitdb }
}
