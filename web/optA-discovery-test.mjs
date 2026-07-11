/**
 * Empirische Optie-A discovery-test.
 *
 * Twee relay-loze (maar circuit-relay-capabele) peers die ALLEEN het anker dialen:
 *   - WRITER (simuleert de anchor-replicator): dialt anker, krijgt reservation,
 *     maakt een verse test-eventlog, schrijft 1 entry, mirrort blocks naar Kubo.
 *   - READER (simuleert de browser): verse node, dialt ALLEEN het anker, opent
 *     dezelfde store op adres en wacht of de entry binnenkomt.
 *
 * Vraag: vindt de READER de WRITER automatisch (via floodsub subscription-change ->
 * libp2p dialt de relayed addr uit identify/peerstore), of moet het relayed adres
 * expliciet geseed/gedialed worden?
 *
 * Modus via argv:
 *   --auto   : reader dialt alleen het anker, geen seeding (test automatische discovery)
 *   --seed   : reader dialt expliciet het writer-relayed-adres (geprint door writer)
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLibp2p } from 'libp2p'
import { webSockets } from '@libp2p/websockets'
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2'
import { identify } from '@libp2p/identify'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { floodsub } from '@libp2p/floodsub'
import { generateKeyPairFromSeed } from '@libp2p/crypto/keys'
import { multiaddr } from '@multiformats/multiaddr'
import { createHelia } from 'helia'
import { bitswap } from '@helia/block-brokers'
import { FsBlockstore } from 'blockstore-fs'
import { FsDatastore } from 'datastore-fs'
import { createOrbitDB, IPFSAccessController, Entry } from '@orbitdb/core'

const ANCHOR = '/dns4/178-105-222-179.k51qzi5uqu5dhg914bwk9z8r2da9ng7tlwo9i2v7ccg4r9elb9usk11s01lx5g.libp2p.direct/tcp/4002/tls/ws/p2p/12D3KooWDF22jexz4kUJgAzGaZ9f3gZr4pPkUnMKpGoUeLaQifv3'
const KUBO_RPC = (process.env.ABUNDOMY_KUBO_RPC || 'http://127.0.0.1:5099').replace(/\/$/, '')
const ROLE = process.argv[2]            // 'writer' | 'reader'
const MODE = process.argv[3] || '--auto'
const STORE_ADDR = process.argv[4] || ''  // reader krijgt store-adres mee
const SEED_ADDR = process.argv[5] || ''   // reader --seed: writer relayed addr
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function kuboBlockPut (bytes) {
  const fd = new FormData()
  fd.append('data', new Blob([bytes]))
  const res = await fetch(`${KUBO_RPC}/api/v0/block/put?cid-codec=dag-cbor&mhtype=sha2-256&pin=true`, { method: 'POST', body: fd })
  if (!res.ok) throw new Error(`block put ${res.status}`)
  return (await res.json()).Key
}
function attachMirror (ipfs) {
  const origPut = ipfs.blockstore.put.bind(ipfs.blockstore)
  ipfs.blockstore.put = async (cid, bytes, opts) => {
    const res = await origPut(cid, bytes, opts)
    kuboBlockPut(bytes).catch(() => {})
    return res
  }
}

async function makeNode (seed) {
  const dir = mkdtempSync(join(tmpdir(), `optA-${ROLE}-`))
  const privateKey = await generateKeyPairFromSeed('Ed25519', createHash('sha256').update(seed).digest())
  const libp2p = await createLibp2p({
    privateKey,
    addresses: { listen: ['/p2p-circuit'] },
    transports: [webSockets(), circuitRelayTransport()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    connectionGater: { denyDialMultiaddr: () => false },
    services: { identify: identify(), pubsub: floodsub({ emitSelf: true }) },
  })
  const ipfs = await createHelia({ libp2p, blockstore: new FsBlockstore(join(dir, 'b')), datastore: new FsDatastore(join(dir, 'd')), blockBrokers: [bitswap()], routers: [] })
  const orbitdb = await createOrbitDB({ ipfs, id: seed, directory: join(dir, 'o') })
  return { libp2p, ipfs, orbitdb, dir }
}

async function waitReservation (libp2p, t = 20000) {
  const start = Date.now()
  while (Date.now() - start < t) {
    const got = libp2p.getMultiaddrs().map(String).find((m) => m.includes('/p2p-circuit'))
    if (got) return got
    await sleep(300)
  }
  return null
}

if (ROLE === 'writer') {
  const n = await makeNode('optA-writer-seed-v1')
  attachMirror(n.ipfs)
  await n.libp2p.dial(multiaddr(ANCHOR))
  const relayed = await waitReservation(n.libp2p)
  const db = await n.orbitdb.open('optA-test-store-v1', { type: 'events', sync: true, AccessController: IPFSAccessController({ write: ['*'] }) })
  // signalen voor de orchestrator
  console.log('WRITER_STORE_ADDR=' + db.address.toString())
  console.log('WRITER_RELAYED_ADDR=' + (relayed || 'NONE'))
  console.log('WRITER_PEER=' + n.libp2p.peerId.toString())
  const marker = 'optA-entry-' + Date.now()
  await db.add(marker)
  console.log('WRITER_MARKER=' + marker)
  console.log('WRITER_READY')
  // blijf draaien zodat de reader kan syncen
  n.libp2p.addEventListener('peer:connect', (e) => console.error('[writer] peer connect', e.detail.toString().slice(-8)))
  const anchorPeer = ANCHOR.split('/p2p/')[1]
  setInterval(() => {
    const up = n.libp2p.getConnections().some((c) => c.remotePeer.toString() === anchorPeer)
    if (!up) n.libp2p.dial(multiaddr(ANCHOR)).catch(() => {})
  }, 8000)
  process.on('SIGTERM', () => process.exit(0))
  await new Promise(() => {})
}

if (ROLE === 'reader') {
  const t0 = Date.now()
  const n = await makeNode('optA-reader-seed-' + Date.now())
  n.libp2p.addEventListener('connection:open', (e) => console.error('[reader] conn open', e.detail.remotePeer.toString().slice(-8), e.detail.remoteAddr?.toString().includes('p2p-circuit') ? '(relayed)' : '(direct)'))
  await n.libp2p.dial(multiaddr(ANCHOR))
  await waitReservation(n.libp2p, 15000)
  // BELANGRIJK: open de store EERST (registreert het /orbitdb/heads/<addr>-protocol
  // + pubsub-topic), DAARNA pas naar de writer dialen, zodat de head-exchange op de
  // verse connectie triggert.
  const db = await n.orbitdb.open(STORE_ADDR, { type: 'events', sync: true })
  db.events.on('update', () => console.error('[reader] db update event @', Date.now() - t0, 'ms'))
  await sleep(800)
  if ((MODE === '--seed' || MODE === '--manual') && SEED_ADDR && SEED_ADDR !== 'NONE') {
    try { await n.libp2p.dial(multiaddr(SEED_ADDR)); console.error('[reader] seeded dial OK ->', SEED_ADDR.slice(-12)) }
    catch (e) { console.error('[reader] seeded dial FAIL', e.message) }
    await sleep(1000)
  }
  if (MODE === '--manual' && SEED_ADDR && SEED_ADDR !== 'NONE') {
    // Handmatige head-exchange OVER de limited (relayed) connectie, ZONDER pubsub.
    // Dialt het OrbitDB head-sync-protocol met runOnLimitedConnection:true en voert
    // ontvangen heads in db.log (wat applyOperation ook doet) -> emit update.
    const writerPeer = SEED_ADDR.split('/p2p/').pop()
    const headsAddr = '/orbitdb/heads/' + STORE_ADDR
    try {
      const { peerIdFromString } = await import('@libp2p/peer-id')
      const stream = await n.libp2p.dialProtocol(peerIdFromString(writerPeer), headsAddr, { runOnLimitedConnection: true })
      console.error('[reader] head-sync stream open over relay (proto: ' + (stream.protocol || '?') + ')')
      let n2 = 0
      // Spiegelt OrbitDB's handleReceiveHeads: itereer de stream, decode elke head,
      // join in de log. (We sturen zelf geen heads; de writer pusht de zijne.)
      for await (const value of stream) {
        const headBytes = value.subarray()
        if (!headBytes?.length) continue
        const entry = await Entry.decode(headBytes)
        const updated = await db.log.joinEntry(entry)
        if (updated) { n2++; db.events.emit('update', entry) }
      }
      console.error('[reader] head-sync applied entries:', n2)
    } catch (e) { console.error('[reader] manual head-sync FAIL', e.message + ' / ' + (e.stack||'').split('\n')[1]) }
  }
  if (MODE === '--seed') {
    await sleep(1000)
    try { await db.sync.stop(); await db.sync.start() } catch (e) { console.error('[reader] sync restart err', e.message) }
  }
  let found = null
  const deadline = Date.now() + 40000
  while (Date.now() < deadline && !found) {
    const all = (await db.all()).map((e) => e.value)
    if (all.length) { found = all }
    else await sleep(500)
  }
  const peers = n.libp2p.getPeers().map((p) => p.toString().slice(-8))
  const protos = []
  for (const c of n.libp2p.getConnections()) protos.push(c.remotePeer.toString().slice(-8) + ':' + (c.remoteAddr?.toString().includes('p2p-circuit') ? 'relayed' : 'direct'))
  console.log('READER_PEERS=' + JSON.stringify(peers))
  console.log('READER_CONNS=' + JSON.stringify(protos))
  console.log('READER_PUBSUB_PEERS=' + n.libp2p.services.pubsub.getPeers().length)
  console.log('READER_PUBSUB_TOPICS=' + JSON.stringify(n.libp2p.services.pubsub.getTopics()))
  if (found) console.log('READER_RESULT=SYNCED in ' + (Date.now() - t0) + 'ms :: ' + JSON.stringify(found))
  else console.log('READER_RESULT=NOSYNC after ' + (Date.now() - t0) + 'ms')
  process.exit(found ? 0 : 2)
}
