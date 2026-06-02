/**
 * Client-side profielversleuteling (Fase 4) met een **gedeelde community-sleutel**.
 *
 * IPFS is publiek en permanent, dus de proof-of-personhood-velden (foto, lengte,
 * haar, oogkleur, geboortedatum, e-mail…) worden AES-GCM-versleuteld vóór opslag.
 * Bekende deelnemers delen één sleutel (afgeleid uit `COMMUNITY_SECRET`) en kunnen
 * elkaars profielen lezen; buitenstaanders niet.
 *
 * WebCrypto (`globalThis.crypto.subtle`) → browser-overdraagbaar voor de latere SPA.
 */
const te = new TextEncoder()
const td = new TextDecoder()

/** Velden die versleuteld worden; de rest blijft leesbaar (id, naam, start, hash, vlaggen). */
export const SENSITIVE_FIELDS = [
  'usersEmail', 'image', 'birthday', 'gender', 'height', 'hair',
  'leftEye', 'rightEye', 'specialFeatures',
]

// base64 helpers — portable (btoa/atob; Node 16+ en browser). Chunked i.v.m. grote
// foto's (spread van een hele Uint8Array kan de call-stack overschrijden).
function b64(u8) {
  let s = ''
  const chunk = 0x8000
  for (let i = 0; i < u8.length; i += chunk) s += String.fromCharCode(...u8.subarray(i, i + chunk))
  return btoa(s)
}
function unb64(str) {
  const bin = atob(str)
  const u8 = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
  return u8
}

/** Leid een 256-bits AES-GCM-sleutel af uit het community-geheim (PBKDF2). */
export async function deriveCommunityKey(secret, salt = 'abundomy-community-v1') {
  const base = await crypto.subtle.importKey('raw', te.encode(secret), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: te.encode(salt), iterations: 100_000, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

/** Versleutel een object → `{ iv, ct }` (base64). Nieuwe IV per oproep. */
export async function encryptJSON(obj, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(JSON.stringify(obj)))
  return { iv: b64(iv), ct: b64(new Uint8Array(ct)) }
}

/** Ontsleutel `{ iv, ct }` → het oorspronkelijke object. */
export async function decryptJSON(blob, key) {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(blob.iv) }, key, unb64(blob.ct))
  return JSON.parse(td.decode(pt))
}

/**
 * Maak een opslagklaar user-doc: gevoelige velden gaan in een `enc`-blob, de rest
 * blijft leesbaar (zodat `usersId`/`start`/`hash` bruikbaar blijven voor index,
 * saldo en proposal-integriteit).
 */
export async function encryptUserProfile(user, key) {
  const sensitive = {}
  const clear = { ...user }
  for (const f of SENSITIVE_FIELDS) {
    if (f in clear) { sensitive[f] = clear[f]; delete clear[f] }
  }
  clear.enc = await encryptJSON(sensitive, key)
  return clear
}

/** Keer `encryptUserProfile` om: voeg de ontsleutelde velden terug toe. */
export async function decryptUserProfile(doc, key) {
  if (!doc?.enc) return doc
  const { enc, ...clear } = doc
  return { ...clear, ...(await decryptJSON(enc, key)) }
}
