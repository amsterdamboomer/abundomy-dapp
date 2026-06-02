/**
 * Statische content publiceren naar IPFS via Helia UnixFS (Fase 4).
 *
 * Voegt een map content-addressed toe → één root-CID. Werkt voor de Abundomy-
 * contentsite én later voor de SPA-build zelf. Lokaal-only voorlopig; pinning/
 * gateway is Fase 5.
 */
import { unixfs, globSource } from '@helia/unixfs'
import { CID } from 'multiformats/cid'

/**
 * Voeg een hele map recursief toe aan IPFS.
 * @returns {Promise<import('multiformats').CID>} de root-CID van de map.
 */
export async function publishDir(helia, dirPath) {
  const fs = unixfs(helia)
  let rootCid
  for await (const entry of fs.addAll(globSource(dirPath, '**/*'), { wrapWithDirectory: true })) {
    rootCid = entry.cid // de laatste entry is de omhullende map
  }
  return rootCid
}

/**
 * Lees een bestand (op naam, in de root) terug uit IPFS — voor verificatie.
 * `cat()` in @helia/unixfs accepteert geen pad-optie, dus eerst de file-CID
 * opzoeken via `ls`.
 */
export async function readFile(helia, cid, name) {
  const fs = unixfs(helia)
  let target = cid
  if (name) {
    let found
    for await (const entry of fs.ls(cid)) if (entry.name === name) found = entry.cid
    if (!found) throw new Error(`'${name}' niet gevonden in de map`)
    target = found
  }
  // CID herparsen: ls en cat gebruiken verschillende multiformats-kopieën, anders
  // weigert cat de CID ("Path must be string or CID").
  const chunks = []
  for await (const chunk of fs.cat(CID.parse(target.toString()))) chunks.push(chunk)
  return Buffer.concat(chunks)
}

/** Lijst de namen in een IPFS-map. */
export async function listDir(helia, cid) {
  const fs = unixfs(helia)
  const names = []
  for await (const entry of fs.ls(cid)) names.push(entry.name)
  return names
}
