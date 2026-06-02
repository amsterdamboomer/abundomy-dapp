/**
 * Fase 1 — Datamigratie: `1CoinH_24_05_2026.sql` → OrbitDB (lokaal, persistent).
 *
 * Draaien: `npm run migrate`. Idempotent: stopt als er al data staat (verwijder
 * `.abundomy-data/` om opnieuw te migreren).
 *
 * Keuzes:
 * - `usersPwd` wordt **niet** gemigreerd: auth gaat via sleutelpaar (bevestigde
 *   keuze) — wachtwoorden vervallen.
 * - Gevoelige profielvelden worden **client-side versleuteld** met de gedeelde
 *   community-sleutel vóór opslag (Fase 4). `usersId`/`start`/`hash` blijven leesbaar.
 * - `users_old` wordt slank gemigreerd zodat saldi (`joined`) niet meer van de
 *   SQL-dump afhangen tijdens runtime.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { startNode, stopNode } from '../src/orbit.mjs'
import { openStores, closeStores } from '../src/stores.mjs'
import { importDump, countStores } from './import.mjs'
import { deriveCommunityKey } from '../src/crypto.mjs'
import { COMMUNITY_SECRET } from '../src/config.mjs'

const SQL_PATH = fileURLToPath(new URL('../../1CoinH_24_05_2026.sql', import.meta.url))
const log = (...a) => console.log('•', ...a)

let node
try {
  log('SQL-dump lezen:', SQL_PATH)
  const sql = readFileSync(SQL_PATH, 'utf8')

  log('OrbitDB starten (persistent, op schijf)…')
  node = await startNode({ persist: true })
  const stores = await openStores(node.orbitdb)

  log('Importeren (profielen versleuteld met community-sleutel)…')
  const communityKey = await deriveCommunityKey(COMMUNITY_SECRET)
  const { skipped, expected } = await importDump(stores, sql, { communityKey })
  if (skipped) {
    log('⚠️  Stores bevatten al data — migratie overgeslagen.')
    log('    Verwijder .abundomy-data/ om opnieuw te migreren.')
  } else {
    log('Klaar met schrijven.')
  }

  // Verificatie: tel terug uit de stores en vergelijk met de bron.
  const counts = await countStores(stores)
  console.log('\nVerificatie (store / bron):')
  let ok = true
  for (const k of Object.keys(expected)) {
    const match = counts[k] === expected[k]
    ok = ok && match
    console.log(`  ${match ? '✅' : '❌'} ${k}: ${counts[k]} / ${expected[k]}`)
  }

  await closeStores(stores)
  if (!ok) throw new Error('aantallen komen niet overeen')
  console.log('\n✅ FASE 1 MIGRATIE GESLAAGD — data staat in OrbitDB (.abundomy-data/).')
} catch (err) {
  console.error('\n❌ MIGRATIE MISLUKT:', err)
  process.exitCode = 1
} finally {
  if (node) await stopNode(node)
}
