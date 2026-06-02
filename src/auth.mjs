/**
 * Wachtwoord-keystore (Fase 4 — auth via naam+wachtwoord).
 *
 * Een nieuwe gebruiker kiest bij aanmelden een wachtwoord. We bewaren NOOIT het
 * wachtwoord (ook niet gehasht), maar een **versleutelde keystore**: de willekeurige
 * seed (= de enige bron van de keypair/identiteit) wordt met een uit het wachtwoord
 * afgeleide AES-GCM-sleutel versleuteld. Login = keystore ontsleutelen met het
 * wachtwoord; fout wachtwoord → de GCM-auth-tag faalt → geen seed.
 *
 * Alleen de eigenaar kan het wachtwoord wijzigen: dat vereist (a) het huidige
 * wachtwoord om de seed te krijgen, en (b) de daaruit afgeleide keypair om de
 * record-update te ondertekenen (zie `authString`/`signup` in identity.mjs).
 *
 * WebCrypto (`globalThis.crypto.subtle`) → werkt in Node 18+ én in de browser-SPA.
 */
const te = new TextEncoder()
const td = new TextDecoder()

/** PBKDF2-iteraties — bewust hoog (de keystore staat publiek in OrbitDB). */
export const KDF_ITER = 600_000

// base64 helpers — portable (btoa/atob; Node 18+ en browser).
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

/**
 * Wachtwoord-eisen (1-op-1 met de oude 1CoinH-signup: ">7 az+AZ+09+!@").
 * @returns {string|null} foutmelding, of `null` als het wachtwoord voldoet.
 */
export function validatePassword(pwd) {
  if (!pwd || pwd.length <= 7) return 'wachtwoord moet langer dan 7 tekens zijn'
  if (!/[a-z]/.test(pwd)) return 'wachtwoord mist een kleine letter'
  if (!/[A-Z]/.test(pwd)) return 'wachtwoord mist een hoofdletter'
  if (!/[0-9]/.test(pwd)) return 'wachtwoord mist een cijfer'
  if (!/[^a-zA-Z0-9]/.test(pwd)) return 'wachtwoord mist een speciaal teken (bv. !@#$)'
  return null
}

/** Leid een AES-GCM-sleutel af uit het wachtwoord + salt (PBKDF2-SHA256). */
async function deriveKeystoreKey(password, saltBytes, iter) {
  const base = await crypto.subtle.importKey('raw', te.encode(password), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: saltBytes, iterations: iter, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

/**
 * Versleutel een seed onder een wachtwoord → keystore-object (alle bytes base64).
 * Nieuwe salt + IV per oproep, dus wachtwoord-wijziging levert een andere keystore.
 */
export async function createKeystore(seed, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await deriveKeystoreKey(password, salt, KDF_ITER)
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(seed))
  return { v: 1, kdf: 'PBKDF2-SHA256', iter: KDF_ITER, salt: b64(salt), iv: b64(iv), ct: b64(new Uint8Array(ct)) }
}

/**
 * Ontsleutel een keystore met het wachtwoord → de seed.
 * @throws bij een fout wachtwoord (de GCM-auth-tag verifieert dan niet).
 */
export async function openKeystore(keystore, password) {
  if (!keystore?.ct) throw new Error('dit account heeft geen wachtwoord-keystore')
  const key = await deriveKeystoreKey(password, unb64(keystore.salt), keystore.iter ?? KDF_ITER)
  let pt
  try {
    pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(keystore.iv) }, key, unb64(keystore.ct))
  } catch {
    throw new Error('verkeerd wachtwoord')
  }
  return td.decode(pt)
}

/**
 * Versleutel dezelfde seed opnieuw onder een nieuw wachtwoord (wachtwoord wijzigen).
 * Identiek aan `createKeystore`, maar expliciet benoemd voor de wijzig-flow.
 */
export async function rekeyKeystore(seed, newPassword) {
  return createKeystore(seed, newPassword)
}

// Crockford-achtige base32 zonder verwarrende tekens (geen 0/O/1/I/L).
const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

/** Genereer een willekeurige herstelcode (ruwe vorm, alleen A-Z2-9 — ~100 bits bij len 20). */
export function generateRecoveryCode(len = 20) {
  const bytes = crypto.getRandomValues(new Uint8Array(len))
  let s = ''
  for (let i = 0; i < len; i++) s += RECOVERY_ALPHABET[bytes[i] % RECOVERY_ALPHABET.length]
  return s
}

/** Groepeer een ruwe herstelcode met streepjes (leesbaar in de e-mail): ABCD-EFGH-… */
export const formatRecoveryCode = (raw) => raw.match(/.{1,4}/g)?.join('-') ?? raw

/** Normaliseer een door de gebruiker getypte code (streepjes/spaties weg, hoofdletters). */
export const normalizeRecoveryCode = (code) => String(code).toUpperCase().replace(/[^A-Z0-9]/g, '')
