/**
 * IPNS-publicatie (Fase 5 — hosting, IPFS-native, geen externe diensten/Qortal).
 *
 * IPNS geeft een **stabiele, herpubliceerbare naam** (`/ipns/<key>`) die naar de
 * huidige site-CID wijst. De sleutel zit in de libp2p-keychain; met een persistente
 * datastore blijft de naam gelijk over runs heen — alleen het doel-CID verandert als
 * de site wijzigt. Voor publieke bereikbaarheid moet de node draaien (of later een
 * remote pinning/relay-dienst).
 */
import { ipns } from '@helia/ipns'
import { CID } from 'multiformats/cid'

/**
 * Publiceer een IPNS-record `keyName → cid`.
 * @returns {Promise<{ipnsName: string, publicKey: any}>} `ipnsName` = de /ipns-naam (CID-string).
 */
export async function publishName(helia, keyName, cid) {
  const name = ipns(helia)
  const { publicKey } = await name.publish(keyName, cid)
  return { ipnsName: publicKey.toCID().toString(), publicKey }
}

/** Los een IPNS-naam (string of CID/PublicKey) op naar de huidige CID. */
export async function resolveName(helia, ipnsName, { offline = true } = {}) {
  const name = ipns(helia)
  const key = typeof ipnsName === 'string' ? CID.parse(ipnsName) : ipnsName
  const { cid } = await name.resolve(key, { offline })
  return cid
}
