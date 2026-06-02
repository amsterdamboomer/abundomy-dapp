/**
 * wipe-users.mjs — verwijder ALLE gebruikers uit de live OrbitDB `users`-store
 * (voor een schone test). Verbindt als client met de relay (zoals de mailer) en
 * repliceert; `del` propageert naar relay, mailer, SER5 en browsers.
 *
 *   node web/wipe-users.mjs            # DRY-RUN: telt + toont e-mails, verwijdert NIETS
 *   node web/wipe-users.mjs --yes      # verwijdert echt alle users
 *   node web/wipe-users.mjs --yes --emails   # + verwijder e-mailbindingen via de mailer-admin
 *
 * Omkeerbaar voor de 17 gemigreerde users: `npm run migrate` herimporteert ze.
 * Raakt alléén de users-store (+ optioneel e-mailbindingen); transactions/proposals/
 * lists blijven staan.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { webSockets } from '@libp2p/websockets'
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2'
import { identify } from '@libp2p/identify'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { floodsub } from '@libp2p/floodsub'
import { generateKeyPairFromSeed } from '@libp2p/crypto/keys'
import { multiaddr } from '@multiformats/multiaddr'
import { createHelia } from 'helia'
import { FsBlockstore } from 'blockstore-fs'
import { FsDatastore } from 'datastore-fs'
import { createOrbitDB } from '@orbitdb/core'
import { openStores } from '../src/stores.mjs'
import { deriveCommunityKey, decryptUserProfile } from '../src/crypto.mjs'
import { COMMUNITY_SECRET } from '../src/config.mjs'

const DO_DELETE = process.argv.includes('--yes')
const DO_EMAILS = process.argv.includes('--emails')
const ROOT = fileURLToPath(new URL('../.abundomy-wipe/', import.meta.url))
const RELAY_JSON = fileURLToPath(new URL('./public/relay.json', import.meta.url))
const MAILER_ADMIN = process.env.MAILER_ADMIN || 'http://127.0.0.1:9100'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const relay = JSON.parse(readFileSync(RELAY_JSON, 'utf8'))
const RELAY_ADDR = process.env.ABUNDOMY_RELAY_ADDR || relay.addr

const privateKey = await generateKeyPairFromSeed('Ed25519', createHash('sha256').update('abundomy-wipe').digest())
const libp2p = await createLibp2p({
  privateKey,
  addresses: { listen: [] },
  transports: [tcp(), webSockets(), circuitRelayTransport()],
  connectionEncrypters: [noise()],
  streamMuxers: [yamux()],
  connectionGater: { denyDialMultiaddr: () => false },
  services: { identify: identify(), pubsub: floodsub({ emitSelf: true }) },
})
const ipfs = await createHelia({ libp2p, blockstore: new FsBlockstore(`${ROOT}blocks`), datastore: new FsDatastore(`${ROOT}data`) })
const orbitdb = await createOrbitDB({ ipfs, id: 'abundomy-wipe', directory: `${ROOT}orbitdb` })

console.log(`• verbinden met relay: ${RELAY_ADDR}`)
await libp2p.dial(multiaddr(RELAY_ADDR))
const stores = await openStores(orbitdb, { addresses: relay.stores })
const communityKey = await deriveCommunityKey(COMMUNITY_SECRET)

// even laten synchroniseren
process.stdout.write('• synchroniseren')
for (let i = 0; i < 20; i++) { process.stdout.write('.'); await sleep(500); if ((await stores.users.all()).length > 0) break }
console.log('')

const users = (await stores.users.all()).map((e) => e.value)
console.log(`\n${users.length} gebruiker(s) in de store:`)
const emails = []
for (const u of users) {
  let email = '?'
  try { email = (await decryptUserProfile(u, communityKey)).usersEmail || '—' } catch {}
  if (email && email !== '—' && email !== '?') emails.push(email)
  console.log(`  #${u.usersId}  ${u.usersName ?? ''}  <${email}>  uid=${u.usersUid ?? '—'}`)
}

if (!DO_DELETE) {
  console.log(`\nDRY-RUN — er is NIETS verwijderd. Draai met --yes om echt te wissen.`)
} else {
  console.log(`\n▶ verwijderen…`)
  for (const u of users) { await stores.users.del(u.usersId); console.log(`  ✗ user #${u.usersId} verwijderd`) }
  if (DO_EMAILS) {
    for (const email of emails) {
      try {
        const r = await fetch(`${MAILER_ADMIN}/admin/del-email?email=${encodeURIComponent(email)}`)
        const j = await r.json()
        console.log(`  ✉ binding ${email}: ${j.deleted ? 'verwijderd' : (j.note || 'n.v.t.')}`)
      } catch (e) { console.log(`  ✉ binding ${email}: mailer-admin onbereikbaar (${e.message})`) }
    }
  }
  const left = (await stores.users.all()).length
  console.log(`\n✅ klaar — ${left} user(s) over in de lokale replica.`)
  await sleep(2000) // even tijd om de del-entries naar de relay te pushen
}

try { await orbitdb.stop() } catch {}
try { await ipfs.stop() } catch {}
process.exit(0)
