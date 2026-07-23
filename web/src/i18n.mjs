/**
 * Client-side i18n voor de money-app SPA — dezelfde aanpak als de content-site:
 * één woordenboek (json/app-i18n.json: 69 talen × ~336 sleutels, 1-op-1 uit de
 * originele 1CoinH `$translations`), een `t(key, ...args)` die de actieve taal pakt
 * (val terug op Engels), en een `setLang()` die de keuze in localStorage bewaart
 * onder DEZELFDE sleutel als de content-site (`abundomy-lang`) zodat de taal mee
 * reist tussen site en app.
 *
 * De vertaalwaarden kunnen een `|transliteratie`-suffix hebben (zoals het PHP-`t()`):
 * we nemen altijd het deel vóór de `|`. `%s`/`%d` worden op volgorde ingevuld.
 */

const LS_KEY = 'abundomy-lang'

// Native namen per code — 1-op-1 uit set-language.php (de 68 keuzes van het origineel).
export const LANGUAGES = {
  ah: 'አማርኛ Amharic', ar: 'عربي Arabic', am: 'Armenian հայկ', az: 'Azərbaycan',
  by: 'беларускі Belarus', be: 'বাংলা Bengali', bo: 'Bosanski Bosnian', bg: 'български Bulgaria',
  ca: '廣州話 Cantonese', ch: '簡體中文 Chinese', cz: 'čeština Czech', se: 'Cрпски Serbian',
  da: 'Dansk', de: 'Deutsch', en: 'English', es: 'Espagnol', fp: 'Filipino', fr: 'Français',
  ir: 'Gaeilge Irish', gr: 'ελληνικά Greece', ha: 'Hausa Nigeria', he: 'עִברִيت Hebrew',
  hi: 'हिंदी Hindi', cr: 'Hrvatski Croatia', ig: 'Igbo Nigeria', in: 'Indonesia',
  ic: 'íslenskur Iceland', it: 'Italiano', ja: '日本語 Japanese', ka: 'қазақ Kazakh',
  kh: 'Khmer ខ្មែរ', ki: 'Kinyarwanda', sh: 'Kiswahili', co: 'Kituba Congo', ko: '한국인 Korean',
  kg: 'Kyrgyz', la: 'ພາສາລາວ Lao', lv: 'Latviski Latvia', lt: 'Lietuvių Lithuania',
  hu: 'Magyar Hungary', mg: 'Malagasy', ma: 'Marathi India', ml: 'Melayu Malaysia',
  mo: 'Монгол Mongolia', bu: 'မြန်မာ Myanmar', ne: 'Nederlands', np: 'नेपाली Nepal',
  no: 'Norsk', or: 'Oromoo Ethiopia', pa: 'Pashto Afghanistan', pe: 'Persian', po: 'Polski',
  pt: 'Português', ro: 'Română', ru: 'Русский Russian', zi: 'Setswana Zimbab.',
  al: 'Shqiptare Albania', sl: 'Slovenski Slovenia', sk: 'Slovenský Slovak', so: 'Soomaali',
  fi: 'Suomalainen Fin.', sw: 'Svenska Sweden', ta: 'தமிழ் Tamil', th: 'แบบไทย Thailand',
  vi: 'Tiếng Việt Vietnam', tu: 'Türkçe', ur: 'اردو Urdu Pakistan', yo: 'Yoruba Nigeria',
}

// Rechts-naar-links schriften (zelfde set als de content-site).
const RTL_LANGS = ['ar', 'he', 'pe', 'ur', 'pa']

/**
 * App-specifieke teksten die in het origineel niet als losse sleutel bestonden
 * (de SPA heeft o.a. een gecombineerd privacy-/lijstpaneel). Alleen en+nl; andere
 * talen vallen via `t()` automatisch terug op Engels.
 */
const EXTRA = {
  en: {
    APP_PROFILE: 'PROFILE',
    APP_PRIV_TITLE: 'Privacy & lists',
    APP_PRIV_WL_MODE: 'White-list mode: only people you allow can send you requests.',
    APP_PRIV_BL_MODE: 'Black-list mode: everyone may, except those you block.',
    APP_TO_WL: 'Switch to white list',
    APP_TO_BL: 'Switch to black list',
    APP_WL_REMOVE: 'Remove from white list',
    APP_WL_ALLOW: 'Allow (white list)',
    APP_ADD_WL: 'Add to white list',
    APP_ADD: 'Add',
    APP_ALLOW: 'Allow ',
    APP_BLOCK: 'Block ',
    APP_NONE_ALLOWED: 'Nobody allowed yet.',
    APP_NONE_BLOCKED: 'Nobody blocked.',
    APP_EMAIL_PREFS: 'Email preferences',
    APP_EDIT: 'Edit details',
    APP_REQUEST_PAYMENT: 'Request a payment',
    APP_REQUEST_HINT: 'You are the receiver; the chosen user has to confirm.',
    APP_FROM: 'From',
    APP_SEND_REQUEST: 'Send request',
    APP_TOOLS: 'System Information',
    APP_EXPORT_CSV: 'Export my chain (CSV)',
    APP_REFRESH: 'Refresh',
    APP_CHANGE_PWD: 'Change password',
    APP_CHANGE_PWD_HINT: 'Only you can do this — it needs your current password. Your identity and balance stay the same.',
    APP_CUR_PWD: 'Current password',
    APP_NEW_PWD: 'New password',
    APP_REPEAT_NEW: 'Repeat new',
    APP_RESET_TITLE: 'Reset password',
    APP_RESET_HINT: 'Enter your e-mail and the recovery code from your welcome mail, and choose a new password.',
    APP_RECOVERY_CODE: 'Recovery code',
    APP_SIGNUP_TITLE: 'New account',
    APP_SIGNUP_HINT: 'One human = one account. Your e-mail is verified and unique. You choose a username and password to log in with from now on.',
    APP_CHOOSE_PHOTO: 'Choose photo',
    APP_REMOVE_PHOTO: 'Remove photo',
    APP_SIGNUP_VERIFY: 'Register & verify e-mail',
    APP_GO_ACCOUNT: 'Go to my account',
    APP_HAVE_ACCOUNT: 'Already have an account? Log in',
    APP_EMAIL: 'E-mail address',
    APP_USER_OR_EMAIL: 'User / e-mail',
    APP_EMAIL_CHANGE: 'Change e-mail address (with verification)',
    APP_NEW_EMAIL: 'New e-mail address',
    APP_SEND_VERIFY: 'Send verification',
    APP_NONE_THIS_MONTH: 'No transactions this month.',
    APP_FEATURES_PH: 'special features',
    APP_DESC_PH: 'description',
  },
  ne: {
    APP_PROFILE: 'PROFIEL',
    APP_PRIV_TITLE: 'Privacy & lijsten',
    APP_PRIV_WL_MODE: 'Witte-lijst-modus: alleen wie je toestaat kan je verzoeken sturen.',
    APP_PRIV_BL_MODE: 'Zwarte-lijst-modus: iedereen mag, behalve wie je blokkeert.',
    APP_TO_WL: 'Schakel naar witte lijst',
    APP_TO_BL: 'Schakel naar zwarte lijst',
    APP_WL_REMOVE: 'Uit witte lijst halen',
    APP_WL_ALLOW: 'Toestaan (witte lijst)',
    APP_ADD_WL: 'Aan witte lijst toevoegen',
    APP_ADD: 'Toevoegen',
    APP_ALLOW: 'Toestaan ',
    APP_BLOCK: 'Blokkeren ',
    APP_NONE_ALLOWED: 'Nog niemand toegestaan.',
    APP_NONE_BLOCKED: 'Niemand geblokkeerd.',
    APP_EMAIL_PREFS: 'E-mailvoorkeuren',
    APP_EDIT: 'Gegevens aanpassen',
    APP_REQUEST_PAYMENT: 'Betaling aanvragen',
    APP_REQUEST_HINT: 'Jij bent de ontvanger; de gekozen gebruiker moet bevestigen.',
    APP_FROM: 'Van',
    APP_SEND_REQUEST: 'Verzoek versturen',
    APP_TOOLS: 'Hulpmiddelen, status & log',
    APP_EXPORT_CSV: 'Exporteer mijn keten (CSV)',
    APP_REFRESH: 'Ververs',
    APP_CHANGE_PWD: 'Wachtwoord wijzigen',
    APP_CHANGE_PWD_HINT: 'Alleen jij kunt dit — het vereist je huidige wachtwoord. Je identiteit en saldo blijven ongewijzigd.',
    APP_CUR_PWD: 'Huidig wachtwoord',
    APP_NEW_PWD: 'Nieuw wachtwoord',
    APP_REPEAT_NEW: 'Herhaal nieuw',
    APP_RESET_TITLE: 'Wachtwoord resetten',
    APP_RESET_HINT: 'Vul je e-mailadres en de herstelcode uit je welkomstmail in, en kies een nieuw wachtwoord.',
    APP_RECOVERY_CODE: 'Herstelcode',
    APP_SIGNUP_TITLE: 'Nieuw account',
    APP_SIGNUP_HINT: 'Eén mens = één account. Je e-mail wordt geverifieerd en is uniek. Je kiest een gebruikersnaam en wachtwoord; daarmee log je voortaan in.',
    APP_CHOOSE_PHOTO: 'Foto kiezen',
    APP_REMOVE_PHOTO: 'Foto verwijderen',
    APP_SIGNUP_VERIFY: 'Registreer & verifieer e-mail',
    APP_GO_ACCOUNT: 'Ga naar mijn account',
    APP_HAVE_ACCOUNT: 'Heb je al een account? Inloggen',
    APP_EMAIL: 'E-mailadres',
    APP_USER_OR_EMAIL: 'Gebruiker / e-mail',
    APP_EMAIL_CHANGE: 'E-mailadres wijzigen (met verificatie)',
    APP_NEW_EMAIL: 'Nieuw e-mailadres',
    APP_SEND_VERIFY: 'Verstuur verificatie',
    APP_NONE_THIS_MONTH: 'Geen transacties in deze maand.',
    APP_FEATURES_PH: 'bijzondere kenmerken',
    APP_DESC_PH: 'omschrijving',
  },
}

// ISO-browsercode → de (deels eigenzinnige) codes van de 1CoinH-app. Alleen de
// gangbare gevallen; onbekende browsertalen vallen terug op Engels. Zo opent de app
// out-of-the-box in de browsertaal (zoals het origineel `detectBestLanguage`), terwijl
// een eenmaal gekozen taal altijd voorrang heeft (localStorage).
const NAV_TO_CODE = {
  nl: 'ne', en: 'en', de: 'de', fr: 'fr', es: 'es', it: 'it', pt: 'pt', ru: 'ru',
  pl: 'po', cs: 'cz', sk: 'sk', da: 'da', sv: 'sw', fi: 'fi', no: 'no', nb: 'no',
  hu: 'hu', ro: 'ro', el: 'gr', tr: 'tu', ar: 'ar', he: 'he', fa: 'pe', ur: 'ur',
  hi: 'hi', bn: 'be', ja: 'ja', ko: 'ko', zh: 'ch', th: 'th', vi: 'vi', id: 'in',
  ms: 'ml', uk: 'by', bg: 'bg', hr: 'cr', sr: 'se', sl: 'sl', sq: 'al', lv: 'lv',
  lt: 'lt', et: 'ic', is: 'ic', ga: 'ir', am: 'ah', sw: 'sh', yo: 'yo', ig: 'ig',
  ha: 'ha', so: 'so', ne: 'np', km: 'kh', lo: 'la', my: 'bu', ta: 'ta', mr: 'ma',
  kk: 'ka', mn: 'mo', ky: 'kg', az: 'az', hy: 'am',
}

function detectDefaultLang() {
  try {
    for (const tag of (navigator.languages || [navigator.language || 'en'])) {
      const code = NAV_TO_CODE[String(tag).toLowerCase().split('-')[0]]
      if (code && DICT[code]) return code
    }
  } catch {}
  return 'en'
}

let DICT = {}
let FLAGS = {}
let LANG = 'en'
const listeners = new Set()

/** Eénmalig het woordenboek + de vlaggen laden en de taal kiezen (bewaarde keuze > browsertaal > en). */
export async function loadI18n() {
  const [dict, flags] = await Promise.all([
    fetch('json/app-i18n.json').then((r) => r.json()).catch(() => ({})),
    fetch('json/flags.json').then((r) => r.json()).catch(() => ({})),
  ])
  DICT = dict; FLAGS = flags
  for (const [code, extra] of Object.entries(EXTRA)) {
    DICT[code] = Object.assign({}, DICT[code], extra)
  }
  let saved = null
  try { saved = localStorage.getItem(LS_KEY) } catch {}
  LANG = saved && DICT[saved] ? saved : detectDefaultLang()
  applyDir()
}

/** Is er een woordenboek voor deze taalcode? */
export function hasLang(code) { return !!DICT[code] }

/**
 * Ronde land-vlag als JPG-afbeelding (vroeger inline-SVG; 23 jul 2026 overgezet naar
 * JPG's in img/flags/ — punt 01.1). `flags.json` bevat per taalcode een relatief pad;
 * we geven het terug als <img> (relatief → /app/img/flags/).
 */
export function getFlag(code, uid) {
  const src = FLAGS[code] || FLAGS.en || ''
  if (!src) return ''
  return `<img src="${src}" alt="${uid || code}" class="app-flag-img">`
}

function applyDir() {
  try {
    document.documentElement.lang = LANG
    document.documentElement.dir = RTL_LANGS.includes(LANG) ? 'rtl' : 'ltr'
  } catch {}
}

export function getLang() { return LANG }

/** Taal wisselen + bewaren; roept de geregistreerde luisteraars aan (re-render). */
export function setLang(code) {
  LANG = DICT[code] ? code : 'en'
  try { localStorage.setItem(LS_KEY, LANG) } catch {}
  applyDir()
  for (const fn of listeners) { try { fn(LANG) } catch {} }
}

/** Abonneer op taalwissels (de SPA hangt hier zijn re-render aan). */
export function onLangChange(fn) { listeners.add(fn); return () => listeners.delete(fn) }

/** Vertaal `key` voor de actieve taal (val terug op Engels, dan de sleutel zelf). */
export function t(key, ...args) {
  const cur = DICT[LANG] || {}
  const en = DICT.en || {}
  let raw = cur[key] ?? en[key] ?? key
  raw = String(raw).split('|')[0] // suffix achter | = transliteratie → weglaten
  let i = 0
  return raw.replace(/%[sd]/g, () => (args[i++] ?? ''))
}

/**
 * Vul alle statische teksten in de DOM die met `data-i18n*` zijn gemarkeerd:
 *  - data-i18n="KEY"      → textContent
 *  - data-i18n-ph="KEY"   → placeholder-attribuut
 *  - data-i18n-html="KEY" → innerHTML (voor stukjes met opmaak)
 */
export function applyStaticI18n(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.getAttribute('data-i18n'))
  for (const el of root.querySelectorAll('[data-i18n-ph]')) el.setAttribute('placeholder', t(el.getAttribute('data-i18n-ph')))
  for (const el of root.querySelectorAll('[data-i18n-html]')) el.innerHTML = t(el.getAttribute('data-i18n-html'))
}

