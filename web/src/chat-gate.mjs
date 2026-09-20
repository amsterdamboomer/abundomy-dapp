/**
 * Taal-gate voor MyChat Abundomy-spoor (Route B optie 1, stap 3 interactief).
 *
 * De vertaal-engine (Google PoC; self-hosted LibreTranslate/Argos voor big-tech-vrij)
 * laadt per-taal-modellen — niet elke denkbare taal is haalbaar of snel genoeg. Daarom
 * een **beheerde talen-set**: Patrick kiest welke/hoeveel. De set is nu **interactief**
 * te beheren (stap 3): de bron is `web/public/chat-langs.json` (Patrick bewerkt die);
 * een toggle-UI in de chat-view kan `enabled` per taal aan/uit zetten als override
 * (opgeslagen in `localStorage`, bovenop het JSON-bestand).
 *
 *   dapp-taal ∈ actieve set → die taal (ISO-code voor de engine)
 *   anders                    → EN-fallback (iedereen kan tenminste Engels lezen/schrijven)
 *
 * Codes: de Abundomy-dapp gebruikt eigen taalcodes (zie i18n.mjs LANGUAGES), grotendeels
 * overgenomen uit het originele 1CoinH. Vertaal-engines gebruiken ISO 639-1; chat-langs.json
 * mapt dapp-code → ISO. EN staat altijd effectief aan (fallback).
 */

const LS_PREFIX = 'mychat-gate:'
const LS_KEY = (code) => LS_PREFIX + code

/** Statische fallback-set als chat-langs.json niet opgehaald kan worden (dev zonder server). */
const FALLBACK = [
  { code: 'en', iso: 'en', name: 'English',    enabled: true },
  { code: 'ne', iso: 'nl', name: 'Nederlands', enabled: true },
  { code: 'de', iso: 'de', name: 'Deutsch',    enabled: true },
  { code: 'fr', iso: 'fr', name: 'Français',   enabled: true },
  { code: 'es', iso: 'es', name: 'Espagnol',   enabled: true },
  { code: 'it', iso: 'it', name: 'Italiano',   enabled: true },
]

let _langs = {}        // code -> { iso, name, enabled }
let _loaded = false

/** Haal chat-langs.json op (fallback statisch) + apply localStorage-overrides. Idempotent. */
export async function loadGateLangs() {
  if (_loaded) return _langs
  let base = FALLBACK
  try {
    const r = await fetch('chat-langs.json')
    if (r.ok) {
      const j = await r.json()
      if (Array.isArray(j?.langs) && j.langs.length) base = j.langs
    }
  } catch { /* dev zonder server → fallback */ }
  _langs = {}
  for (const l of base) {
    if (!l?.code) continue
    const ov = localStorage.getItem(LS_KEY(l.code))
    const enabled = ov === null ? !!l.enabled : ov === '1'
    _langs[l.code] = { iso: l.iso || l.code, name: l.name || l.code, enabled }
  }
  _loaded = true
  return _langs
}

/** Herlaad de set vanaf JSON (wis niet de overrides — die blijven bovenop). Voor "reset". */
export async function reloadGateLangs() {
  _loaded = false
  return loadGateLangs()
}

/** ISO-doeltaal voor een dapp-taalcode, of EN-fallback buiten de actieve set. */
export function chatTargetLang(dappCode) {
  const l = _langs[dappCode]
  return (l && l.enabled) ? l.iso : 'en'
}

/** Is deze dapp-taal actief in de set (geen fallback nodig)? */
export function isChatLangSupported(dappCode) {
  const l = _langs[dappCode]
  return !!(l && l.enabled)
}

/** Mens-leesbare naam voor een dapp-taalcode (voor de gate-status-UI). */
export function gateLangName(dappCode) {
  const l = _langs[dappCode]
  return l?.name || 'English'
}

/** Alle kandidaat-talen (voor de toggle-UI). */
export function getGateLangs() {
  return Object.entries(_langs).map(([code, v]) => ({ code, ...v }))
}

/** Zet een taal aan/uit (override → localStorage). Updatet de actieve set direct. */
export function setLangEnabled(code, enabled) {
  try { localStorage.setItem(LS_KEY(code), enabled ? '1' : '0') } catch {}
  if (_langs[code]) _langs[code].enabled = !!enabled
}

/** Wis alle localStorage-overrides + herlaad vanaf JSON (terug naar bestand-standaard). */
export function resetGateOverrides() {
  const keys = []
  try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k?.startsWith(LS_PREFIX)) keys.push(k) } } catch {}
  for (const k of keys) { try { localStorage.removeItem(k) } catch {} }
  _loaded = false
  return reloadGateLangs()
}