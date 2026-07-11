/**
 * Minimale test: peeren twee relay-loze nodes hun FLOODSUB over een circuit-relay
 * connectie via het anker? (los van OrbitDB)
 */
import { createHash } from 'node:crypto'
import { createLibp2p } from 'libp2p'
import { webSockets } from '@libp2p/websockets'
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2'
import { identify } from '@libp2p/identify'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { floodsub } from '@libp2p/floodsub'
import { generateKeyPairFromSeed } from '@libp2p/crypto/keys'
import { multiaddr } from '@multiformats/multiaddr'

const ANCHOR = '/dns4/178-105-222-179.k51qzi5uqu5dhg914bwk9z8r2da9ng7tlwo9i2v7ccg4r9elb9usk11s01lx5g.libp2p.direct/tcp/4002/tls/ws/p2p/12D3KooWDF22jexz4kUJgAzGaZ9f3gZr4pPkUnMKpGoUeLaQifv3'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const TOPIC = 'optA-floodsub-probe'

async function mk (seed) {
  const privateKey = await generateKeyPairFromSeed('Ed25519', createHash('sha256').update(seed).digest())
  const lp = await createLibp2p({
    privateKey,
    addresses: { listen: ['/p2p-circuit'] },
    transports: [webSockets(), circuitRelayTransport()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    connectionGater: { denyDialMultiaddr: () => false },
    services: { identify: identify(), pubsub: floodsub({ emitSelf: true }) },
  })
  return lp
}
async function waitRes (lp, t = 20000) {
  const s = Date.now()
  while (Date.now() - s < t) { const a = lp.getMultiaddrs().map(String).find((m) => m.includes('/p2p-circuit')); if (a) return a; await sleep(300) }
  return null
}

const A = await mk('floodsub-A-seed')
const B = await mk('floodsub-B-seed')
await A.dial(multiaddr(ANCHOR))
await B.dial(multiaddr(ANCHOR))
const aRelayed = await waitRes(A)
console.log('A relayed:', aRelayed ? 'yes' : 'NO')
A.services.pubsub.subscribe(TOPIC)
B.services.pubsub.subscribe(TOPIC)
let got = false
B.services.pubsub.addEventListener('message', (e) => { if (e.detail.topic === TOPIC) { got = true; console.log('B received:', new TextDecoder().decode(e.detail.data)) } })
A.services.pubsub.addEventListener('subscription-change', (e) => console.log('A sub-change from', String(e.detail.peerId).slice(-8)))
B.services.pubsub.addEventListener('subscription-change', (e) => console.log('B sub-change from', String(e.detail.peerId).slice(-8)))

// B dialt A via het relayed adres
await sleep(1000)
try { await B.dial(multiaddr(aRelayed)); console.log('B->A relayed dial OK') } catch (e) { console.log('B->A dial FAIL', e.message) }

for (let i = 0; i < 12; i++) {
  await sleep(1500)
  const ap = A.services.pubsub.getPeers().length
  const bp = B.services.pubsub.getPeers().length
  console.log(`t=${i}: A.pubsubPeers=${ap} B.pubsubPeers=${bp} A.subscribers(${TOPIC})=${A.services.pubsub.getSubscribers(TOPIC).length}`)
  if (ap > 0 && bp > 0) {
    A.services.pubsub.publish(TOPIC, new TextEncoder().encode('hello-over-relay-' + Date.now()))
  }
  if (got) break
}
console.log('RESULT:', got ? 'FLOODSUB-OVER-RELAY-WORKS' : 'FLOODSUB-OVER-RELAY-FAILS')
process.exit(got ? 0 : 2)
