/**
 * Helia/libp2p-opzet voor Abundomy.
 *
 * OrbitDB vereist een libp2p met een `pubsub`-service; de standaard-Helia levert die
 * niet mee. We gebruiken **floodsub** i.p.v. gossipsub: de nieuwste gossipsub
 * (14.x) hangt nog aan `@libp2p/interface@2`, terwijl deze stack (Helia 6 / libp2p 3)
 * op `@libp2p/interface@3` zit. Door die mismatch registreerde gossipsub zijn
 * pubsub-streams niet en repliceerde er niets (peers verbonden, identify OK, maar
 * subscriptions/berichten kwamen nooit aan). floodsub@11 zit wél op interface 3 en
 * is voor een lokale 2-peer PoC ruim voldoende (floodt naar alle subscribers).
 *
 * In-memory voor de rookproef; `persist: true` schrijft naar schijf (APFS) in de
 * dirs uit `config.mjs` — gebruikt door de datamigratie (Fase 1).
 */
import { createHelia } from 'helia'
import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { identify } from '@libp2p/identify'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { floodsub } from '@libp2p/floodsub'
import { generateKeyPair, generateKeyPairFromSeed } from '@libp2p/crypto/keys'
import { FsBlockstore } from 'blockstore-fs'
import { FsDatastore } from 'datastore-fs'
import { createHash } from 'node:crypto'
import { dataDirs } from './node-paths.mjs'

export const libp2pOptions = {
  addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
  transports: [tcp()],
  connectionEncrypters: [noise()],
  streamMuxers: [yamux()],
  services: {
    identify: identify(),
    pubsub: floodsub({ emitSelf: true }),
  },
}

/**
 * Start een Helia-node met de juiste libp2p-config.
 * @param {{persist?: boolean, root?: string, seed?: string}} [opts]
 *   persist=true → FS-opslag op schijf (APFS); `root` kiest de data-root
 *   (per peer uniek in Fase 3). `seed` → deterministische peer-sleutel (zelfde
 *   seed = zelfde peerId); zonder seed een willekeurige sleutel. libp2p genereert
 *   in deze versie géén unieke sleutel vanzelf, dus dit is vereist om twee peers
 *   met verschillende peerId's te krijgen.
 */
export async function createHeliaNode({ persist = false, root, seed } = {}) {
  const privateKey = seed
    ? await generateKeyPairFromSeed('Ed25519', createHash('sha256').update(String(seed)).digest())
    : await generateKeyPair('Ed25519')
  const libp2p = await createLibp2p({ ...libp2pOptions, privateKey })
  if (persist) {
    const dirs = dataDirs(root)
    return createHelia({
      libp2p,
      blockstore: new FsBlockstore(dirs.blockstore),
      datastore: new FsDatastore(dirs.datastore),
    })
  }
  return createHelia({ libp2p })
}
