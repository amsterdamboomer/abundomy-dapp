/**
 * Fase 3 PoC (uitgebreid in Fase 4) — één betaling end-to-end, volledig serverless,
 * tussen twee lokale peers (giver 14 op peer A, receiver 13 op peer B). `npm run poc`.
 *
 * Flow (legacy-getrouw): ontvanger maakt proposal → repliceert → gever bevestigt
 * → transactie in OrbitDB → repliceert terug → saldi geüpdatet op beide peers.
 * Fase 4: profielen zijn versleuteld (community-sleutel); saldi gebruiken de
 * gerepliceerde `users_old`-store (niet meer de SQL-dump). Géén server.
 */
import { readFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { startNode, stopNode } from '../src/orbit.mjs'
import { openStores, storeAddresses, closeStores } from '../src/stores.mjs'
import { importDump } from '../migration/import.mjs'
import { availableCoins, joinedDate, replayChain, parseSqlDate } from '../src/ledger.mjs'
import { createProposal, payProposal } from '../src/payments.mjs'
import { deriveCommunityKey, decryptUserProfile } from '../src/crypto.mjs'
import { exportUserChain, verifyExportedChain } from '../src/export.mjs'
import { COMMUNITY_SECRET } from '../src/config.mjs'

const SQL_PATH = fileURLToPath(new URL('../../1CoinH_24_05_2026.sql', import.meta.url))
const ROOT_A = fileURLToPath(new URL('../.abundomy-poc/peerA/', import.meta.url))
const ROOT_B = fileURLToPath(new URL('../.abundomy-poc/peerB/', import.meta.url))
const GIVER = 14, RECEIVER = 13, AMOUNT = 50
const ASOF = parseSqlDate('2026-05-24 12:00:00') // vast referentiemoment voor saldi
const log = (...a) => console.log('•', ...a)
const money = (n) => n.toFixed(2)

async function waitFor(fn, label, timeout = 40_000) {
  const start = Date.now()
  for (;;) {
    if (await fn()) return
    if (Date.now() - start > timeout) throw new Error(`timeout: ${label}`)
    await new Promise((r) => setTimeout(r, 250))
  }
}
async function balanceOf(stores, userId) {
  const allTxs = (await stores.transactions.all()).map((e) => e.value)
  const userDoc = (await stores.users.get(userId))?.value
  const usersOld = (await stores.usersOld.all()).map((e) => e.value)
  return availableCoins({ joined: joinedDate(userDoc, usersOld), transactions: allTxs, userId, asOf: ASOF })
}

for (const d of [ROOT_A, ROOT_B]) rmSync(d, { recursive: true, force: true })
const sql = readFileSync(SQL_PATH, 'utf8')

let A, B
try {
  const communityKey = await deriveCommunityKey(COMMUNITY_SECRET)

  // ── Peer A (gever 14): seed de volledige dataset (profielen versleuteld) ──
  log('Peer A starten (gever 14) + dataset migreren (versleuteld)…')
  A = await startNode({ persist: true, id: 'abundomy-user-14', root: ROOT_A })
  const storesA = await openStores(A.orbitdb, { write: ['*'] })
  const { expected } = await importDump(storesA, sql, { communityKey })
  const addresses = storeAddresses(storesA)

  // ── Peer B (ontvanger 13): verbind en repliceer ──
  log('Peer B starten (ontvanger 13)…')
  B = await startNode({ persist: true, id: 'abundomy-user-13', root: ROOT_B })
  const pubA = A.ipfs.libp2p.services.pubsub, pubB = B.ipfs.libp2p.services.pubsub
  for (const ma of A.ipfs.libp2p.getMultiaddrs()) await B.ipfs.libp2p.dial(ma)
  await waitFor(() => pubA.getPeers().some((p) => p.equals(B.ipfs.libp2p.peerId)) &&
                      pubB.getPeers().some((p) => p.equals(A.ipfs.libp2p.peerId)), 'pubsub-peers')
  const storesB = await openStores(B.orbitdb, { write: ['*'] })
  if (storeAddresses(storesB).transactions !== addresses.transactions) throw new Error('store-adressen verschillen')

  log('Wachten tot peer B de ledger + users_old heeft gerepliceerd…')
  await waitFor(async () => (await storesB.transactions.all()).length >= expected.transactions &&
                            (await storesB.users.all()).length >= expected.users &&
                            (await storesB.usersOld.all()).length >= expected.usersOld, 'A→B ledger')
  log('Peer B gesynct:', (await storesB.transactions.all()).length, 'transacties,',
      (await storesB.users.all()).length, 'users,', (await storesB.usersOld.all()).length, 'users_old')

  // Bewijs dat versleutelde profielen cross-peer ontsleutelbaar zijn met de community-sleutel.
  const giverProfile = await decryptUserProfile((await storesB.users.get(GIVER)).value, communityKey)
  log(`Profiel van 14 op peer B ontsleuteld: "${giverProfile.usersName}", lengte ${giverProfile.height}`)

  // ── BEFORE: saldi op beide peers ──
  const beforeGiverA = await balanceOf(storesA, GIVER)
  const beforeRecvA = await balanceOf(storesA, RECEIVER)
  const beforeGiverB = await balanceOf(storesB, GIVER)
  console.log('\nSALDI VOOR betaling:')
  console.log(`  gever 14    — A: ${money(beforeGiverA)}  B: ${money(beforeGiverB)}`)
  console.log(`  ontvanger 13— A: ${money(beforeRecvA)}\n`)

  // ── Ontvanger (B) maakt proposal: 13 vraagt 50 van 14 ──
  log(`Ontvanger 13 maakt proposal: 14 → 13, ${AMOUNT} munten…`)
  const giverDoc = (await storesB.users.get(GIVER))?.value
  const receiverDoc = (await storesB.users.get(RECEIVER))?.value
  const proposal = await createProposal({
    stores: storesB, giver: GIVER, receiver: RECEIVER, amount: AMOUNT,
    description: 'PoC: lunch', giverDoc, receiverDoc, asOf: ASOF,
  })
  log('proposal pid:', proposal.pid)

  // ── Proposal repliceert naar A; gever bevestigt ──
  log('Wachten tot proposal bij peer A is…')
  await waitFor(async () => !!(await storesA.proposals.get(proposal.pid)), 'B→A proposal')
  log('Gever 14 bevestigt en betaalt…')
  const usersOldA = (await storesA.usersOld.all()).map((e) => e.value)
  const result = await payProposal({ stores: storesA, proposal, usersOldRows: usersOldA, asOf: ASOF })
  if (!result.paid) throw new Error(`betaling geweigerd: ${result.reason}`)
  log('betaald — nieuwe tid:', result.tx.tid)

  // ── Transactie + verwijderde proposal repliceren terug naar B ──
  log('Wachten tot peer B de nieuwe transactie ziet…')
  await waitFor(async () => (await storesB.transactions.all()).length === expected.transactions + 1, 'A→B nieuwe tx')
  await waitFor(async () => !(await storesB.proposals.get(proposal.pid)), 'A→B proposal verwijderd')

  // ── AFTER: saldi op beide peers ──
  const afterGiverA = await balanceOf(storesA, GIVER)
  const afterRecvA = await balanceOf(storesA, RECEIVER)
  const afterGiverB = await balanceOf(storesB, GIVER)
  const afterRecvB = await balanceOf(storesB, RECEIVER)
  console.log('\nSALDI NA betaling:')
  console.log(`  gever 14    — A: ${money(afterGiverA)}  B: ${money(afterGiverB)}`)
  console.log(`  ontvanger 13— A: ${money(afterRecvA)}  B: ${money(afterRecvB)}\n`)

  // ── Ontvanger exporteert zijn keten en verifieert die zelf (draagbaar bewijs) ──
  const exportCsv = await exportUserChain({ stores: storesB, userId: RECEIVER, communityKey, asOf: ASOF })
  const exportCheck = verifyExportedChain(exportCsv)
  log(`Ontvanger 13 exporteert keten (${exportCheck.checked} tx) — zelf-verificatie: ${exportCheck.valid ? 'geldig' : 'ONGELDIG'}`)

  // ── Go/no-go-checks ──
  const eps = 1e-6
  const checks = [
    ['gever 14 daalt met ~50', Math.abs((beforeGiverA - afterGiverA) - AMOUNT) < eps],
    ['ontvanger 13 stijgt met ~50', Math.abs((afterRecvA - beforeRecvA) - AMOUNT) < eps],
    ['saldi gelijk op beide peers', Math.abs(afterGiverA - afterGiverB) < eps && Math.abs(afterRecvA - afterRecvB) < eps],
    ['proposal verwijderd op beide peers', !(await storesA.proposals.get(proposal.pid)) && !(await storesB.proposals.get(proposal.pid))],
    ['profiel 14 cross-peer ontsleuteld', !!giverProfile.height],
    ['exporteerbare keten zelf-verifieert', exportCheck.valid && exportCheck.checked === 7],
  ]
  const mergedTxs = (await storesB.transactions.all()).map((e) => e.value).sort((a, b) => a.tid - b.tid)
  const replayed = replayChain(mergedTxs).find((r) => r.tid === result.tx.tid)
  checks.push(['replay reproduceert nieuwe tx-hashes',
    replayed.hashgiver === result.tx.hashgiver && replayed.hashreceiver === result.tx.hashreceiver])

  console.log('Go/no-go:')
  let ok = true
  for (const [name, pass] of checks) { ok = ok && pass; console.log(`  ${pass ? '✅' : '❌'} ${name}`) }

  await closeStores(storesA); await closeStores(storesB)
  if (!ok) throw new Error('één of meer checks faalden')
  console.log('\n✅ PoC GESLAAGD — serverless betaling + versleutelde profielen tussen twee peers.')
} catch (err) {
  console.error('\n❌ PoC MISLUKT:', err)
  process.exitCode = 1
} finally {
  if (A) await stopNode(A)
  if (B) await stopNode(B)
}
