/**
 * Node-only opslagpaden (gebruikt door `ipfs.mjs`/`orbit.mjs`). Niet importeren in
 * browsercode — gebruikt `node:url` en het bestandssysteem.
 *
 * Fase 3 draait twee peers naast elkaar → elke peer heeft zijn eigen data-root nodig
 * (twee LevelDB-instanties kunnen niet dezelfde map delen).
 */
import { fileURLToPath } from 'node:url'

export const DEFAULT_DATA_DIR = fileURLToPath(new URL('../.abundomy-data/', import.meta.url))

/** Bouw de blockstore/datastore/orbitdb-paden onder een gegeven root. */
export function dataDirs(root = DEFAULT_DATA_DIR) {
  const base = root.endsWith('/') ? root : `${root}/`
  return {
    root: base,
    blockstore: `${base}blocks`,
    datastore: `${base}data`,
    orbitdb: `${base}orbitdb`,
  }
}

// Backward-compatibele defaults.
const _defaults = dataDirs()
export const DATA_DIR = _defaults.root
export const BLOCKSTORE_DIR = _defaults.blockstore
export const DATASTORE_DIR = _defaults.datastore
export const ORBITDB_DIR = _defaults.orbitdb
