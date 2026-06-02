/**
 * Relay/seed-node voor de browser-SPA (Node). Browsers kunnen geen ws/tcp
 * beluisteren; deze node luistert op WebSockets, draagt de gemigreerde dataset, en
 * relayt verkeer tussen browsers (circuit-relay-v2 + floodsub-doorgifte). Géén
 * applicatieserver — alle logica draait in de browser; dit is enkel connectiviteit.
 *
 * Lokaal draaien: `npm run relay` (schrijft `web/public/relay.json` voor de SPA).
 * Productie: importeer `startRelay()` vanuit `web/server.mjs` — die regelt TLS-
 * terminatie (via Fly), statische hosting en proxiet WS-upgrades naar deze relay.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { webSockets } from '@libp2p/websockets'
import { identify } from '@libp2p/identify'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { floodsub } from '@libp2p/floodsub'
import { circuitRelayServer } from '@libp2p/circuit-relay-v2'
import { generateKeyPairFromSeed } from '@libp2p/crypto/keys'
import { createHelia } from 'helia'
import { FsBlockstore } from 'blockstore-fs'
import { FsDatastore } from 'datastore-fs'
import { createOrbitDB } from '@orbitdb/core'
import { openStores, storeAddresses } from '../src/stores.mjs'
import { importDump } from '../migration/import.mjs'
import { deriveCommunityKey } from '../src/crypto.mjs'
import { COMMUNITY_SECRET } from '../src/config.mjs'

const DEFAULT_ROOT = fileURLToPath(new URL('../.abundomy-relay/', import.meta.url))
const DEFAULT_SQL = fileURLToPath(new URL('../../1CoinH_24_05_2026.sql', import.meta.url))
const DEFAULT_WS_PORT = 9091

/**
 * Start de relay (libp2p + Helia + OrbitDB), seed de dataset, en houd 'm online.
 *
 * @param {object} [opts]
 * @param {string} [opts.rootDir]  Persistente data-root (env `ABUNDOMY_RELAY_ROOT`).
 * @param {string} [opts.sqlPath]  SQL-dump om te importeren (env `ABUNDOMY_SQL`).
 * @param {number} [opts.wsPort]   Interne WS-poort waar de relay op luistert.
 * @param {string} [opts.bind]     Bind-adres (`127.0.0.1` lokaal, `0.0.0.0` in container).
 * @param {string[]} [opts.announce] Publieke multiaddrs zonder /p2p/<id> (libp2p voegt 'm toe).
 * @returns {Promise<{libp2p, ipfs, orbitdb, stores, peerId: string, wsAddr: string, publicAddr: string|null}>}
 */
export async function startRelay (opts = {}) {
  const rootDir = opts.rootDir ?? process.env.ABUNDOMY_RELAY_ROOT ?? DEFAULT_ROOT
  const sqlPath = opts.sqlPath ?? process.env.ABUNDOMY_SQL ?? DEFAULT_SQL
  const wsPort = opts.wsPort ?? (Number(process.env.ABUNDOMY_RELAY_WS_PORT) || DEFAULT_WS_PORT)
  const bind = opts.bind ?? process.env.ABUNDOMY_RELAY_BIND ?? '127.0.0.1'
  const announce = opts.announce ?? (process.env.ABUNDOMY_ANNOUNCE
    ? process.env.ABUNDOMY_ANNOUNCE.split(',').map((s) => s.trim()).filter(Boolean)
    : [])

  const root = rootDir.endsWith('/') ? rootDir : `${rootDir}/`

  const privateKey = await generateKeyPairFromSeed(
    'Ed25519',
    createHash('sha256').update('abundomy-relay').digest(),
  )

  const libp2p = await createLibp2p({
    privateKey,
    addresses: {
      listen: [`/ip4/${bind}/tcp/${wsPort}/ws`, `/ip4/${bind}/tcp/0`],
      announce,
    },
    transports: [tcp(), webSockets()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: {
      identify: identify(),
      pubsub: floodsub({ emitSelf: true }),
      relay: circuitRelayServer(),
    },
  })

  const ipfs = await createHelia({
    libp2p,
    blockstore: new FsBlockstore(`${root}blocks`),
    datastore: new FsDatastore(`${root}data`),
  })
  const orbitdb = await createOrbitDB({ ipfs, id: 'abundomy-relay', directory: `${root}orbitdb` })
  const stores = await openStores(orbitdb, { write: ['*'] })

  const communityKey = await deriveCommunityKey(COMMUNITY_SECRET)
  const { skipped } = await importDump(stores, readFileSync(sqlPath, 'utf8'), { communityKey })
  console.log(skipped ? '• dataset al aanwezig (idempotent)' : '• dataset geseed (versleuteld)')

  const wsAddr = ipfs.libp2p.getMultiaddrs().find((m) => m.toString().includes('/ws')).toString()
  const peerId = libp2p.peerId.toString()
  const publicAddr = announce.length > 0 ? `${announce[0]}/p2p/${peerId}` : null

  // Diagnostiek
  libp2p.addEventListener('peer:connect', (e) =>
    console.log('• browser verbonden:', e.detail.toString().slice(-8),
      '— totaal', libp2p.getConnections().length))
  libp2p.addEventListener('peer:disconnect', (e) =>
    console.log('• browser weg:', e.detail.toString().slice(-8),
      '— totaal', libp2p.getConnections().length))
  stores.proposals.events.on('update', (entry) =>
    console.log('• ⇄ proposal ontvangen: pid', entry?.payload?.value?.pid))
  stores.transactions.events.on('update', (entry) =>
    console.log('• ⇄ transactie ontvangen: tid', entry?.payload?.value?.tid))

  return { libp2p, ipfs, orbitdb, stores, peerId, wsAddr, publicAddr }
}

/** CLI-runner: `npm run relay` — schrijft relay.json zodat de Vite-dev-SPA hem leest. */
async function main () {
  const ADDR_OUT = fileURLToPath(new URL('./public/relay.json', import.meta.url))
  const { ipfs, orbitdb, stores, wsAddr } = await startRelay()

  mkdirSync(fileURLToPath(new URL('./public/', import.meta.url)), { recursive: true })
  writeFileSync(ADDR_OUT, JSON.stringify({ addr: wsAddr, stores: storeAddresses(stores) }, null, 2))

  console.log('\n✅ Relay draait. Laat dit venster open.')
  console.log('   ws-adres :', wsAddr)
  console.log('   adres weggeschreven naar web/public/relay.json (SPA leest dit)')
  console.log('   Start de SPA in een ander venster met:  npm run dev\n')

  const shutdown = async () => { await orbitdb.stop(); await ipfs.stop(); process.exit(0) }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

// Alleen uitvoeren als dit bestand direct gestart wordt (niet bij `import`).
import { pathToFileURL } from 'node:url'
import { realpathSync } from 'node:fs'
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  await main()
}
