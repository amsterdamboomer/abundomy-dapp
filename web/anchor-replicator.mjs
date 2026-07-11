/**
 * anchor-replicator.mjs — always-on OrbitDB-replicator voor het IPFS-only traject.
 *
 * DOEL: relay-loze browsers (Helia + bitswap + floodsub, géén circuit-relay) laten
 * inloggen + repliceren via het Hetzner Kubo-anker, zónder de oude
 * `abundomy-relay.service`. Het Kubo-anker spreekt zelf GÉÉN OrbitDB; deze service
 * vult dat gat:
 *
 *   1. Repliceert alle Abundomy-stores (opent ze op adres uit relay.json → blijft
 *      live in sync via OrbitDB's Sync-protocol, net als de relay/mailer nu doen).
 *   2. MIRRORT elk OrbitDB-block dat hij opslaat naar het Kubo-anker via de Kubo-RPC
 *      `block put` (dag-cbor, sha2-256, pin=true). Bewezen: Kubo reproduceert exact
 *      dezelfde CID die OrbitDB verwacht (base58btc `zdpu…` ↔ `bafyrei…`), dus een
 *      relay-loze browser haalt manifest + access-controller + log-entries via
 *      bitswap RECHTSTREEKS van het anker op. (Block-laag end-to-end geverifieerd.)
 *
 * BELANGRIJKE BEPERKING (transport-laag, NIET door dit bestand opgelost — zie de
 * rapportage): bitswap levert blocks zodra de browser de juiste CID's WIL, maar de
 * browser leert die head-CID's via OrbitDB's head-exchange (`/orbitdb/heads/<addr>`
 * libp2p-dialProtocol) + pubsub-topic-updates. Die lopen peer-to-peer en gaan NIET
 * transitief door het Kubo-anker (gossipsub forwardt geen topics waarop het anker
 * niet zelf subscribed; en twee dial-only peers kunnen elkaar niet dialen). Daarom
 * MOET deze replicator óók direct bereikbaar zijn voor de browser:
 *   - optie A: het anker draait circuit-relay-v2 (`Swarm.RelayService.Enabled=true`)
 *     → browser bereikt deze replicator via het anker als relay (head-exchange werkt);
 *   - optie B: deze replicator luistert zelf op een browser-bereikbare wss
 *     (eigen AutoTLS/nginx-wss) en publiceert dat adres → browser dialt 'm direct.
 * Zolang dat transport-gat openstaat, repliceert deze service correct server-side en
 * vult hij het anker met blocks, maar ziet de browser nog geen heads. Zet ABUNDOMY_
 * REPL_LISTEN om optie B aan te zetten.
 *
 * Houdt zich aan CLAUDE.md: floodsub (NIET gossipsub) aan de OrbitDB-kant; geen
 * platte wachtwoorden (deze service raakt auth-data niet aan, repliceert alleen).
 *
 * Config via env (zie web/anchor-replicator.env.example):
 *   ABUNDOMY_KUBO_RPC        Kubo-RPC van het anker (default http://127.0.0.1:5001).
 *                            Op de Hetzner-box is dat lokaal; elders via SSH-tunnel.
 *   ABUNDOMY_ANCHOR_ADDR     Multiaddr van het anker om als pubsub/transport-peer te
 *                            dialen (default uit relay.json `addr`).
 *   ABUNDOMY_REPL_ROOT       Persistente data-root (default ../.abundomy-anchor-repl/).
 *   ABUNDOMY_REPL_LISTEN     Optioneel: wss/tcp-listen-multiaddr(s), komma-gescheiden
 *                            (optie B). Leeg = dial-only (optie A via anker-relay).
 *   ABUNDOMY_REPL_ANNOUNCE   Optioneel: publieke announce-multiaddr(s) bij optie B.
 *   ABUNDOMY_MIRROR=0        Zet mirroring uit (alleen repliceren, niets naar Kubo).
 *
 * Gebruik:
 *   node web/anchor-replicator.mjs                 # de replicator + block-mirror
 *   node web/anchor-replicator.mjs --env <pad>     # env uit een bestand laden
 *   node web/anchor-replicator.mjs --self-test     # mirror 1 testblock → Kubo, check CID
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { webSockets } from '@libp2p/websockets'
import { webRTCDirect } from '@libp2p/webrtc'
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2'
import { autoTLS } from '@libp2p/auto-tls'
import { autoNAT } from '@libp2p/autonat'
import { keychain } from '@libp2p/keychain'
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
import { createOrbitDB } from '@orbitdb/core'
import { openStores } from '../src/stores.mjs'

// --- optioneel env-bestand laden (zelfde robuuste parser als de mailer) ------
{
  const i = process.argv.indexOf('--env')
  if (i !== -1 && process.argv[i + 1]) {
    for (const line of readFileSync(process.argv[i + 1], 'utf8').split('\n')) {
      if (/^\s*#/.test(line) || !line.includes('=')) continue
      const k = line.slice(0, line.indexOf('=')).trim()
      const v = line.slice(line.indexOf('=') + 1).trim()
      if (k) process.env[k] ??= v
    }
  }
}

const RELAY_JSON = fileURLToPath(new URL('./public/relay.json', import.meta.url))
const ROOT = (process.env.ABUNDOMY_REPL_ROOT || fileURLToPath(new URL('../.abundomy-anchor-repl/', import.meta.url))).replace(/\/?$/, '/')
const KUBO_RPC = (process.env.ABUNDOMY_KUBO_RPC || 'http://127.0.0.1:5001').replace(/\/$/, '')
const MIRROR = process.env.ABUNDOMY_MIRROR !== '0'
const LISTEN = (process.env.ABUNDOMY_REPL_LISTEN || '').split(',').map((s) => s.trim()).filter(Boolean)
const ANNOUNCE = (process.env.ABUNDOMY_REPL_ANNOUNCE || '').split(',').map((s) => s.trim()).filter(Boolean)
// Optie B: geef de replicator een eigen browser-bereikbare wss via AutoTLS
// (*.libp2p.direct, zelfde p2p-forge-truc als Kubo → geen beheerd domein nodig).
// Vereist een /ws-listener in ABUNDOMY_REPL_LISTEN en een publiek bereikbare TCP-poort.
const AUTOTLS = process.env.ABUNDOMY_REPL_AUTOTLS === '1'
// Optie B (domeinloos): luister óók op WebRTC-Direct. De browser dialt het
// /udp/<poort>/webrtc-direct/certhash/...-adres rechtstreeks en verifieert tegen de
// certhash — GEEN CA, GEEN domein, GEEN nginx. Volwaardige (niet-gelimiteerde)
// verbinding, dus OrbitDB-sync werkt. Op de Hetzner-box is de publieke IP direct
// gebonden, dus het certhash-adres met 178.105.222.179 staat vanzelf in getMultiaddrs().
const WEBRTC_PORT = (process.env.ABUNDOMY_REPL_WEBRTC_PORT || '').trim()
// Bootstrap-bron(nen) voor bestaande store-data (komma-gescheiden multiaddrs),
// bv. de oude relay tijdens de migratie. Een verse replicator heeft de entries
// nog niet; hij haalt ze via OrbitDB-sync van deze peer(s).
const BOOTSTRAP = (process.env.ABUNDOMY_BOOTSTRAP_ADDRS || '').split(',').map((s) => s.trim()).filter(Boolean)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Mirror één block naar het Kubo-anker via RPC `block put`. OrbitDB-blocks zijn
 * dag-cbor + sha2-256; met `cid-codec=dag-cbor&mhtype=sha2-256` reproduceert Kubo
 * EXACT dezelfde CID (geverifieerd), dus de browser haalt 'm via bitswap van het
 * anker. `pin=true` zodat het anker 'm niet GC't.
 */
async function kuboBlockPut (bytes) {
  const fd = new FormData()
  fd.append('data', new Blob([bytes]))
  const url = `${KUBO_RPC}/api/v0/block/put?cid-codec=dag-cbor&mhtype=sha2-256&pin=true`
  const res = await fetch(url, { method: 'POST', body: fd })
  if (!res.ok) throw new Error(`block put ${res.status}: ${await res.text().catch(() => '')}`)
  return (await res.json()).Key
}

/**
 * Wikkel de Helia-blockstore zodat ELK opgeslagen block ook naar het anker gaat.
 * Mirroren gebeurt best-effort (faalt nooit de OrbitDB-put): bij een tijdelijke
 * RPC-hapering wordt de CID in een retry-wachtrij gezet en later opnieuw geduwd.
 */
function attachMirror (ipfs) {
  const origPut = ipfs.blockstore.put.bind(ipfs.blockstore)
  const origPutMany = ipfs.blockstore.putMany?.bind(ipfs.blockstore)
  const retry = new Map() // cidString → bytes
  let mirrored = 0, failed = 0

  const push = async (cid, bytes) => {
    try { await kuboBlockPut(bytes); mirrored++; retry.delete(cid.toString()) }
    catch (e) { failed++; retry.set(cid.toString(), bytes); }
  }

  ipfs.blockstore.put = async (cid, bytes, opts) => {
    const res = await origPut(cid, bytes, opts)
    push(cid, bytes) // niet awaiten: mirror op de achtergrond, blokkeer de OrbitDB-put niet
    return res
  }
  if (origPutMany) {
    ipfs.blockstore.putMany = async function * (source, opts) {
      for await (const { cid, block } of origPutMany(source, opts)) {
        push(cid, block)
        yield { cid, block }
      }
    }
  }

  // Retry-lus voor blocks die het anker (tijdelijk) niet aannam.
  const loop = setInterval(async () => {
    if (retry.size === 0) return
    for (const [cidStr, bytes] of [...retry]) {
      try { const { CID } = await import('multiformats/cid'); await push(CID.parse(cidStr), bytes) } catch {}
    }
  }, 10000)

  return {
    stats: () => ({ mirrored, failed, pending: retry.size }),
    stop: () => clearInterval(loop),
  }
}

// --- self-test: mirror één bekend testblock en check de CID --------------------
if (process.argv.includes('--self-test')) {
  const Block = await import('multiformats/block')
  const dagCbor = await import('@ipld/dag-cbor')
  const { sha256 } = await import('multiformats/hashes/sha2')
  const value = { id: 'abundomy-anchor-selftest', payload: { t: Date.now() }, next: [], refs: [], v: 2 }
  const block = await Block.encode({ value, codec: dagCbor, hasher: sha256 })
  console.log('• lokaal block CID:', block.cid.toString())
  const key = await kuboBlockPut(block.bytes)
  console.log('• Kubo block put  :', key)
  console.log(key === block.cid.toString()
    ? '✓ CID-match — het anker serveert OrbitDB-blocks correct via bitswap.'
    : '✗ CID-MISMATCH — mirroring zou geen bruikbare blocks opleveren!')
  process.exit(key === block.cid.toString() ? 0 : 1)
}

// --- service -------------------------------------------------------------------
const relay = JSON.parse(readFileSync(RELAY_JSON, 'utf8'))
const ANCHOR_ADDR = process.env.ABUNDOMY_ANCHOR_ADDR || relay.addr

const privateKey = await generateKeyPairFromSeed('Ed25519', createHash('sha256').update('abundomy-anchor-replicator').digest())
const libp2p = await createLibp2p({
  privateKey,
  // GEEN libp2p-`announce` (zie AutoTLS-deadlock, nu niet gebruikt).
  addresses: { listen: WEBRTC_PORT ? [...LISTEN, `/ip4/0.0.0.0/udp/${WEBRTC_PORT}/webrtc-direct`] : LISTEN },
  transports: [tcp(), webSockets(), ...(WEBRTC_PORT ? [webRTCDirect()] : []), circuitRelayTransport()],
  connectionEncrypters: [noise()],
  streamMuxers: [yamux()],
  connectionGater: { denyDialMultiaddr: () => false },
  services: {
    identify: identify(),
    pubsub: floodsub({ emitSelf: true }),
    // AutoTLS heeft de keychain (cert-opslag) + autonat (publieke bereikbaarheid) nodig.
    ...(AUTOTLS ? { keychain: keychain(), autoNAT: autoNAT(), autoTLS: autoTLS() } : {}),
  },
})
// AutoTLS heeft een BEVESTIGD publiek adres nodig; een server met vaste public IP
// krijgt geen inbound vóór de wss live is, dus AutoNAT bevestigt niet vanzelf (kip-ei).
// Markeer de geannounceerde adressen expliciet als observed+confirmed → AutoTLS start.
if (AUTOTLS && ANNOUNCE.length) {
  const am = libp2p.components.addressManager
  const ev = libp2p.components.events
  // AutoTLS checkt alléén op een `self:peer:update`-event. Een server met vaste IP
  // krijgt zonder organische inbound geen AutoNAT-bevestiging (kip-ei). We confirmen
  // het publieke adres als observed én FORCEREN het event zodat AutoTLS herchecked —
  // op een interval tot het *.libp2p.direct-cert binnen is.
  const ensurePublicAddr = () => {
    for (const a of ANNOUNCE) {
      try { am.addObservedAddr(multiaddr(a)); am.confirmObservedAddr(multiaddr(a), { type: 'observed' }) } catch {}
    }
    try { ev.dispatchEvent(new CustomEvent('self:peer:update', { detail: {} })) } catch {}
  }
  ensurePublicAddr()
  const tlsTimer = setInterval(() => {
    if (libp2p.getMultiaddrs().some((m) => m.toString().includes('libp2p.direct'))) {
      clearInterval(tlsTimer)
      console.log('• AutoTLS wss:', libp2p.getMultiaddrs().map(String).filter((m) => m.includes('libp2p.direct')).join(' , '))
    } else ensurePublicAddr()
  }, 8000)
}

// Bitswap-only (géén trustless-gateways/delegated-routing): blocks komen van peers
// (bootstrap-relay + browsers), net als de relay/browser. Voorkomt gateway-crashes.
const ipfs = await createHelia({ libp2p, blockstore: new FsBlockstore(`${ROOT}blocks`), datastore: new FsDatastore(`${ROOT}data`), blockBrokers: [bitswap()], routers: [] })

const mirror = MIRROR ? attachMirror(ipfs) : null
if (!MIRROR) console.log('⚠ ABUNDOMY_MIRROR=0 → blocks worden NIET naar het anker gespiegeld (alleen repliceren).')

const orbitdb = await createOrbitDB({ ipfs, id: 'abundomy-anchor-replicator', directory: `${ROOT}orbitdb` })

console.log(`• verbinden met anker: ${ANCHOR_ADDR}`)
await libp2p.dial(multiaddr(ANCHOR_ADDR)).catch((e) => console.log('  ⚠ anker-dial faalde:', e.message))
for (const b of BOOTSTRAP) {
  try { await libp2p.dial(multiaddr(b)); console.log('• bootstrap-peer verbonden:', b.slice(-14)) }
  catch (e) { console.log('• ⚠ bootstrap-dial faalde:', b.slice(-14), '—', e.message) }
}
console.log('• anker-self-test (mirror-CID):', MIRROR ? 'aan' : 'uit')

// Open de stores OP NAAM (write:['*']) — net als relay/mailer/browser: deterministische
// manifests (identieke adressen), géén manifest-fetch nodig. Bestaande entries komen
// via OrbitDB-sync van de bootstrap-peer(s); nieuwe writes van browsers komen live binnen.
const stores = await openStores(orbitdb, { write: ['*'] })
console.log('• stores geopend op naam:', Object.keys(stores).join(', '))
// Sanity: de adressen moeten matchen met relay.json (anders openen browsers andere stores).
for (const [k, db] of Object.entries(stores)) {
  const want = relay.stores?.[k]
  if (want && db.address.toString() !== want) console.log(`  ⚠ adres-mismatch '${k}': ${db.address} != ${want}`)
}

// Diagnostiek + mirror-stats.
for (const [name, db] of Object.entries(stores)) {
  db.events.on('update', () => console.log(`⇄ update in '${name}'`))
}
libp2p.addEventListener('peer:connect', (e) =>
  console.log('• peer verbonden:', e.detail.toString().slice(-8), '— totaal', libp2p.getConnections().length))

// Houd de anker-verbinding levend + log mirror-voortgang.
setInterval(async () => {
  if (libp2p.getConnections().length === 0) {
    try { await libp2p.dial(multiaddr(ANCHOR_ADDR)) } catch {}
  }
  if (mirror) {
    const s = mirror.stats()
    if (s.mirrored || s.failed || s.pending) console.log(`• mirror: ${s.mirrored} ok, ${s.failed} retries, ${s.pending} pending`)
  }
}, 15000)

if (LISTEN.length) console.log('• luistert op:', libp2p.getMultiaddrs().map((m) => m.toString()).join(' , '))
else console.log('• dial-only — geen eigen listener (browsers kunnen deze replicator niet direct bereiken).')
if (AUTOTLS) {
  console.log('• AutoTLS aan — wss-cert wordt provisioned (kan enkele minuten duren).')
  libp2p.addEventListener('self:peer:update', () => {
    const wss = libp2p.getMultiaddrs().map(String).filter((m) => m.includes('libp2p.direct'))
    if (wss.length) console.log('• AutoTLS wss-adres(sen):', wss.join(' , '))
  })
}

console.log('✅ anchor-replicator actief — repliceert stores + spiegelt blocks naar het Kubo-anker.')

const shutdown = async () => {
  try { mirror?.stop() } catch {}
  try { await orbitdb.stop() } catch {}
  try { await ipfs.stop() } catch {}
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
