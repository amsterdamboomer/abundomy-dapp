/**
 * Operationele fork-scan (Fase 5): open de lokale OrbitDB-store en rapporteer of
 * een gebruikersketen is geforkt (bewijsbare double-spend). Draaien: `npm run scan:forks`.
 */
import { startNode, stopNode } from '../src/orbit.mjs'
import { openStores, closeStores } from '../src/stores.mjs'
import { detectAllForks } from '../src/fork-detection.mjs'

let node
try {
  node = await startNode({ persist: true })
  const stores = await openStores(node.orbitdb)
  const txs = (await stores.transactions.all()).map((e) => e.value)
  const users = new Set(txs.flatMap((t) => [t.giver, t.receiver])).size
  console.log(`• ${txs.length} transacties gescand over ${users} gebruikers`)

  const forks = detectAllForks(txs)
  if (forks.length === 0) {
    console.log('\n✅ Geen forks gevonden — ledger is gezond.')
  } else {
    console.log(`\n❌ ${forks.length} gebruiker(s) met een fork (bewijsbare double-spend):`)
    for (const f of forks) {
      for (const c of f.conflicts) {
        console.log(`   user ${f.userId}: tid ${c.parentTid} heeft conflicterende kinderen ${c.children.join(' & ')}`)
      }
    }
    process.exitCode = 1
  }
  await closeStores(stores)
} catch (err) {
  console.error('❌ SCAN MISLUKT:', err)
  process.exitCode = 1
} finally {
  if (node) await stopNode(node)
}
