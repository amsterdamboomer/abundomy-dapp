/**
 * Publiceer de statische Abundomy-contentsite (`web/site-dist/`) naar IPFS en
 * verifieer door terug te lezen. Draaien: `npm run publish:site` (na `build:site`).
 *
 * Lokaal-only: levert een root-CID op die via een IPFS-gateway te bekijken is. Echte
 * pinning/hosting (zodat het CID online blijft) is Fase 5.
 */
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createHelia } from 'helia'
import { FsBlockstore } from 'blockstore-fs'
import { FsDatastore } from 'datastore-fs'
import { publishDir, readFile, listDir } from '../src/publish.mjs'
import { publishName, resolveName } from '../src/ipns.mjs'

const SITE = fileURLToPath(new URL('./site-dist/', import.meta.url))
const IPFS_DIR = fileURLToPath(new URL('../.abundomy-ipfs/', import.meta.url))

if (!existsSync(SITE)) {
  console.error('Geen web/site-dist/ — draai eerst:  npm run build:site')
  process.exit(1)
}

// Niet wissen: blockstore + keychain blijven persistent zodat de IPNS-naam stabiel
// blijft over republicaties (content-addressing maakt opnieuw toevoegen idempotent).
const helia = await createHelia({
  blockstore: new FsBlockstore(`${IPFS_DIR}blocks`),
  datastore: new FsDatastore(`${IPFS_DIR}data`),
})

try {
  console.log('• Site toevoegen aan IPFS (content-addressed)…')
  const cid = await publishDir(helia, SITE)
  console.log('• root-CID:', cid.toString())

  // Verificatie: lees de map + index.html terug uit IPFS.
  const names = await listDir(helia, cid)
  const html = (await readFile(helia, cid, 'index.html')).toString('utf8')
  const ok = names.includes('index.html') && html.includes('<title>') && !html.includes('<?php')

  console.log('• root bevat:', names.slice(0, 8).join(', '), names.length > 8 ? `… (${names.length} entries)` : '')
  console.log('• index.html teruggelezen:', html.length, 'bytes; geldige HTML:', !html.includes('<?php'))

  // Pin de root (voorkomt GC) — de fs-blockstore bewaart de blokken persistent.
  try { await helia.pins.add(cid); console.log('• root gepind (recursief)') } catch (e) { console.log('• pin overgeslagen:', e.message) }

  // Stabiele IPNS-naam die naar de huidige site-CID wijst (herpubliceerbaar).
  console.log('• IPNS-record publiceren…')
  const { ipnsName } = await publishName(helia, 'abundomy-site', cid)
  const resolved = await resolveName(helia, ipnsName)
  const ipnsOk = resolved.toString() === cid.toString()
  console.log(`• IPNS-naam: ${ipnsName}  →  ${resolved}  ${ipnsOk ? '✓' : '✗'}`)

  const allOk = ok && ipnsOk
  console.log(allOk
    ? `\n✅ CONTENTSITE GEHOST OP IPFS\n   CID (immutabel): /ipfs/${cid}/\n   IPNS (stabiel) : /ipns/${ipnsName}/  (wijst altijd naar de laatste publicatie)\n   Gepind in .abundomy-ipfs/. Voor publieke bereikbaarheid: deze node online houden\n   (of later een remote pinning/relay-dienst). Géén Qortal.`
    : '\n❌ verificatie faalde')
  if (!allOk) process.exitCode = 1
} catch (err) {
  console.error('\n❌ PUBLICEREN MISLUKT:', err)
  process.exitCode = 1
} finally {
  await helia.stop()
}
