/**
 * Browser-variant van de Helia/libp2p-node voor de SPA — RELAY-LOOS qua INFRA,
 * maar wél circuit-relay-CAPABEL (Optie A).
 *
 * - Transport: Secure WebSockets (wss — via de AutoTLS-cert van het anker op
 *   `*.libp2p.direct`) + WebTransport (QUIC, direct met certhash) om het Hetzner-anker
 *   te dialen. Daarnaast `circuitRelayTransport()` zodat de browser via het anker
 *   (dat circuit-relay-v2 hop draait) de anchor-replicator kan bereiken voor OrbitDB's
 *   head-exchange (`/p2p/<anker>/p2p-circuit/p2p/<replicator>`). De browser dialt zelf
 *   nog steeds maar één infra-adres (het anker) — géén eigen relay-service, géén webRTC.
 * - Opslag: IndexedDB (blockstore-idb / datastore-idb).
 * - Identiteit: deterministische Ed25519-sleutel uit de seed (zelfde seed = zelfde
 *   peerId + OrbitDB-identiteit).
 */
import { createLibp2p } from 'libp2p'
import { webSockets } from '@libp2p/websockets'
import { webTransport } from '@libp2p/webtransport'
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
    // Browser dialt alleen (luistert niet). Secure WebSockets dialt het anker
    // (libp2p.direct, blocks) én de replicator (sslip.io-wss, OrbitDB-heads);
    // WebTransport is een extra directe route naar het anker voor blocks.
    addresses: { listen: [] },
    transports: [webSockets(), webTransport()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    connectionGater: { denyDialMultiaddr: () => false }, // localhost in dev toestaan
    services: { identify: identify(), pubsub: floodsub({ emitSelf: true }) },
  })

  const blockstore = new IDBBlockstore(`abundomy-blocks-${seed}`)
  const datastore = new IDBDatastore(`abundomy-data-${seed}`)
  await blockstore.open()
  await datastore.open()

  // Relay-loos: blocks komen rechtstreeks van het anker via bitswap. Géén externe
  // trustless-gateways en géén delegated routing (delegated-ipfs.dev).
  const ipfs = await createHelia({ libp2p, blockstore, datastore, blockBrokers: [bitswap()], routers: [] })
  const orbitdb = await createOrbitDB({ ipfs, id: seed, directory: `abundomy-orbitdb-${seed}` })
  return { ipfs, orbitdb }
}
