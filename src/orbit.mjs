/**
 * OrbitDB-node opstarten/stoppen met persistente opslag op schijf (APFS).
 *
 * `createOrbitDB({ directory })` legt zélf een LevelDB-keystore en de database-
 * bestanden onder die map aan — geen aparte KeyStore nodig.
 */
import { createOrbitDB } from '@orbitdb/core'
import { createHeliaNode } from './ipfs.mjs'
import { dataDirs } from './node-paths.mjs'

/**
 * Start Helia + OrbitDB. `id` is het identiteitslabel (de "sleutelpaar"-identiteit
 * van een gebruiker; deterministisch via de keystore). `root` isoleert de opslag
 * per peer — nodig voor de twee-peer PoC in Fase 3.
 *
 * @param {{persist?: boolean, id?: string, root?: string}} [opts]
 * @returns {Promise<{ipfs: any, orbitdb: any}>}
 */
export async function startNode({ persist = true, id = 'abundomy-node', root } = {}) {
  const ipfs = await createHeliaNode({ persist, root, seed: id }) // peerId deterministisch per id
  const orbitdb = await createOrbitDB({ ipfs, id, directory: dataDirs(root).orbitdb })
  return { ipfs, orbitdb }
}

export async function stopNode({ ipfs, orbitdb } = {}) {
  if (orbitdb) await orbitdb.stop()
  if (ipfs) await ipfs.stop()
}
