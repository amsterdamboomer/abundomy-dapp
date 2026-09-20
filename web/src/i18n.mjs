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
    APP_TOOLS: 'Tools, status & log',
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
    // --- MyChat (Abundomy-spoor) ---
    CHAT_NAV: 'Chat',
    CHAT_TITLE: 'MYCHAT — OPEN CHAT',
    CHAT_IDLE: 'not connected',
    CHAT_CONNECTING: 'connecting…',
    CHAT_CONNECTED: 'connected',
    CHAT_DISCONNECTED: 'disconnected — reconnecting',
    CHAT_CONN_ERR: 'connection error',
    CHAT_ALONE: 'only you',
    CHAT_ME: 'you',
    CHAT_TYPING: 'is typing…',
    CHAT_SIGNED: 'Ed25519-signed (dapp-identity)',
    CHAT_VERIFYING: 'verifying signature…',
    CHAT_VERIFIED: 'Ed25519 signature verified ✓ (genuine, from this dapp-identity)',
    CHAT_INVALID_SIG: 'INVALID signature ✗ — message not from the claimed identity (possible impersonation/fraud)',
    CHAT_UNSIGNED: 'not signed (no Ed25519 signature)',
    CHAT_VERIFY_ERR: 'verification failed (crypto error)',
    CHAT_HISTORY: 'from history',
    CHAT_PLACEHOLDER: 'Type a message…',
    CHAT_SEND: 'Send',
    CHAT_HISTORY_SUMMARY: 'History on IPFS (open/transparent)',
    CHAT_HISTORY_DESC: 'Open/transparent — history plaintext + Ed25519 signatures on IPFS (immutable CIDs). The PBFS2/IPFS-anchor CID is the authoritative pinned source.',
    CHAT_PIN_IDLE: 'pinning to PBFS2/IPFS-anchor: pending…',
    CHAT_PINNED_PI: '✓ pinned to PBFS2/IPFS-anchor (publicly readable via IPFS gateway)',
    CHAT_PIN_FAIL: '⚠ pinning to PBFS2/IPFS-anchor failed — see error below',
    CHAT_GATE_OK: 'Language supported: %s — messages are translated to this language.',
    CHAT_GATE_FALLBACK: 'Your dapp language (%s) is not in the chat language set — you see English translations (EN fallback).',
    CHAT_LANGS_TITLE: 'Manage language set (taal-gate)',
    CHAT_LANGS_HINT: 'Tick which languages the chat supports. Changes apply immediately (override in this browser). Source: web/public/chat-langs.json (edited by Patrick). EN is always on (fallback).',
    CHAT_LANGS_RESET: 'Reset to file default',
    CHAT_IDENTITY: 'Logged in as %s (#%s) — messages are Ed25519-signed with your dapp-identity.',
    CHAT_NO_KEY: 'no account key — log in again with password to chat',
    CHAT_KEY_ERR: 'key error',
    CHAT_XLATE_LOCAL: 'Translation: local (SER5)',
    CHAT_XLATE_CLOUD: 'Translation: Google (cloud)',
    CHAT_XLATE_MOCK: 'Translation: mock (test)',
    CHAT_XLATE_DOWN: 'translation unavailable',
    CHAT_XLATE_HOVER: 'translated via local · %d ms',
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
    // --- MyChat (Abundomy-spoor) ---
    CHAT_NAV: 'Chat',
    CHAT_TITLE: 'MYCHAT — OPEN CHAT',
    CHAT_IDLE: 'niet verbonden',
    CHAT_CONNECTING: 'verbinden…',
    CHAT_CONNECTED: 'verbonden',
    CHAT_DISCONNECTED: 'verbroken — verbind opnieuw',
    CHAT_CONN_ERR: 'verbindingsfout',
    CHAT_ALONE: 'alleen jij',
    CHAT_ME: 'jij',
    CHAT_TYPING: 'is aan het typen…',
    CHAT_SIGNED: 'Ed25519-ondertekend (dapp-identity)',
    CHAT_VERIFYING: 'handtekening verifiëren…',
    CHAT_VERIFIED: 'Ed25519-handtekening geverifieerd ✓ (echt van deze dapp-identity)',
    CHAT_INVALID_SIG: 'ONGELDIGE handtekening ✗ — bericht komt niet van de beweerde identity (mogelijke impersonation/fraud)',
    CHAT_UNSIGNED: 'niet ondertekend (geen Ed25519-signature)',
    CHAT_VERIFY_ERR: 'verificatie mislukt (crypto-fout)',
    CHAT_HISTORY: 'uit geschiedenis',
    CHAT_PLACEHOLDER: 'Typ een bericht…',
    CHAT_SEND: 'Verstuur',
    CHAT_HISTORY_SUMMARY: 'Geschiedenis op IPFS (open/transparant)',
    CHAT_HISTORY_DESC: 'Open/transparant — geschiedenis plaintext + Ed25519-signatures op IPFS (immutable CIDs). De PBFS2/IPFS-anchor-CID is de authoritatieve gepinde bron.',
    CHAT_PIN_IDLE: 'pinnen op PBFS2/IPFS-anchor: in afwachting…',
    CHAT_PINNED_PI: '✓ gepind op PBFS2/IPFS-anchor (openbaar leesbaar via IPFS-gateway)',
    CHAT_PIN_FAIL: '⚠ pinnen op PBFS2/IPFS-anchor mislukt — zie fout hieronder',
    CHAT_GATE_OK: 'Taal ondersteund: %s — berichten worden naar deze taal vertaald.',
    CHAT_GATE_FALLBACK: 'Je dapp-taal (%s) zit niet in de chat-talen-set — je ziet Engelse vertalingen (EN-fallback).',
    CHAT_LANGS_TITLE: 'Talen-set beheren (taal-gate)',
    CHAT_LANGS_HINT: 'Vink aan/uit welke talen de chat ondersteunt. Wijzigingen gelden direct (override in deze browser). Bron: web/public/chat-langs.json (bewerkt Patrick). EN staat altijd aan (fallback).',
    CHAT_LANGS_RESET: 'Reset naar bestand-standaard',
    CHAT_IDENTITY: 'Ingelogd als %s (#%s) — berichten worden Ed25519-ondertekend met je dapp-identity.',
    CHAT_NO_KEY: 'geen account-sleutel — log opnieuw in met wachtwoord om te kunnen chatten',
    CHAT_KEY_ERR: 'sleutel-fout',
    CHAT_XLATE_LOCAL: 'Vertaling: lokaal (SER5)',
    CHAT_XLATE_CLOUD: 'Vertaling: Google (cloud)',
    CHAT_XLATE_MOCK: 'Vertaling: mock (test)',
    CHAT_XLATE_DOWN: 'vertaling niet beschikbaar',
    CHAT_XLATE_HOVER: 'vertaald via lokaal · %d ms',
  },
  de: {
    // --- MyChat (Abundomy-spoor) ---
    CHAT_NAV: 'Chat',
    CHAT_TITLE: 'MYCHAT — OFFENER CHAT',
    CHAT_IDLE: 'nicht verbunden',
    CHAT_CONNECTING: 'verbinden…',
    CHAT_CONNECTED: 'verbunden',
    CHAT_DISCONNECTED: 'getrennt — neu verbinden',
    CHAT_CONN_ERR: 'Verbindungsfehler',
    CHAT_ALONE: 'nur du',
    CHAT_ME: 'du',
    CHAT_TYPING: 'tippt…',
    CHAT_SIGNED: 'Ed25519-signiert (dapp-identity)',
    CHAT_VERIFYING: 'Signatur wird geprüft…',
    CHAT_VERIFIED: 'Ed25519-Signatur geprüft ✓ (echt, von dieser dapp-identity)',
    CHAT_INVALID_SIG: 'UNGÜLTIGE Signatur ✗ — Nachricht nicht von der behaupteten identity (möglicher Identitätsbetrug)',
    CHAT_UNSIGNED: 'nicht signiert (keine Ed25519-Signatur)',
    CHAT_VERIFY_ERR: 'Prüfung fehlgeschlagen (Krypto-Fehler)',
    CHAT_HISTORY: 'aus Verlauf',
    CHAT_PLACEHOLDER: 'Nachricht schreiben…',
    CHAT_SEND: 'Senden',
    CHAT_HISTORY_SUMMARY: 'Verlauf auf IPFS (offen/transparent)',
    CHAT_HISTORY_DESC: 'Offen/transparent — Verlauf plaintext + Ed25519-Signaturen auf IPFS (unveränderliche CIDs). Die PBFS2/IPFS-anchor-CID ist die maßgebliche gepinnte Quelle.',
    CHAT_PIN_IDLE: 'pinnen auf PBFS2/IPFS-anchor: wartend…',
    CHAT_PINNED_PI: '✓ auf PBFS2/IPFS-anchor gepinnt (öffentlich lesbar via IPFS-Gateway)',
    CHAT_PIN_FAIL: '⚠ pinnen auf PBFS2/IPFS-anchor fehlgeschlagen — siehe Fehler unten',
    CHAT_GATE_OK: 'Sprache unterstützt: %s — Nachrichten werden in diese Sprache übersetzt.',
    CHAT_GATE_FALLBACK: 'Deine dapp-Sprache (%s) ist nicht im Chat-Sprachenset — du siehst englische Übersetzungen (EN-Fallback).',
    CHAT_LANGS_TITLE: 'Sprachenset verwalten (taal-gate)',
    CHAT_LANGS_HINT: 'Wähle, welche Sprachen der Chat unterstützt. Änderungen gelten sofort (Override in diesem Browser). Quelle: web/public/chat-langs.json (von Patrick). EN ist immer an (Fallback).',
    CHAT_LANGS_RESET: 'Auf Datei-Standard zurücksetzen',
    CHAT_IDENTITY: 'Angemeldet als %s (#%s) — Nachrichten werden mit deiner dapp-identity Ed25519-signiert.',
    CHAT_NO_KEY: 'kein Account-Schlüssel — zum Chatten erneut mit Passwort anmelden',
    CHAT_KEY_ERR: 'Schlüssel-Fehler',
    CHAT_XLATE_LOCAL: 'Übersetzung: lokal (SER5)',
    CHAT_XLATE_CLOUD: 'Übersetzung: Google (cloud)',
    CHAT_XLATE_MOCK: 'Übersetzung: mock (test)',
    CHAT_XLATE_DOWN: 'Übersetzung nicht verfügbar',
    CHAT_XLATE_HOVER: 'übersetzt via lokal · %d ms',
  },
  fr: {
    // --- MyChat (Abundomy-spoor) ---
    CHAT_NAV: 'Chat',
    CHAT_TITLE: 'MYCHAT — CHAT OUVERT',
    CHAT_IDLE: 'non connecté',
    CHAT_CONNECTING: 'connexion…',
    CHAT_CONNECTED: 'connecté',
    CHAT_DISCONNECTED: 'déconnecté — reconnexion',
    CHAT_CONN_ERR: 'erreur de connexion',
    CHAT_ALONE: 'seul(e)',
    CHAT_ME: 'toi',
    CHAT_TYPING: 'écrit…',
    CHAT_SIGNED: 'signé Ed25519 (dapp-identity)',
    CHAT_VERIFYING: 'vérification de la signature…',
    CHAT_VERIFIED: 'signature Ed25519 vérifiée ✓ (authentique, de cette dapp-identity)',
    CHAT_INVALID_SIG: 'signature INVALIDE ✗ — le message ne vient pas de l\'identity revendiquée (usurpation possible)',
    CHAT_UNSIGNED: 'non signé (pas de signature Ed25519)',
    CHAT_VERIFY_ERR: 'vérification échouée (erreur crypto)',
    CHAT_HISTORY: 'de l\'historique',
    CHAT_PLACEHOLDER: 'Tape un message…',
    CHAT_SEND: 'Envoyer',
    CHAT_HISTORY_SUMMARY: 'Historique sur IPFS (ouvert/transparent)',
    CHAT_HISTORY_DESC: 'Ouvert/transparent — historique en clair + signatures Ed25519 sur IPFS (CID immuables). Le CID PBFS2/IPFS-anchor est la source épinglée faisant autorité.',
    CHAT_PIN_IDLE: 'épinglage sur PBFS2/IPFS-anchor : en attente…',
    CHAT_PINNED_PI: '✓ épinglé sur PBFS2/IPFS-anchor (lisible publiquement via la passerelle IPFS)',
    CHAT_PIN_FAIL: '⚠ épinglage sur PBFS2/IPFS-anchor échoué — voir l\'erreur ci-dessous',
    CHAT_GATE_OK: 'Langue prise en charge : %s — les messages sont traduits dans cette langue.',
    CHAT_GATE_FALLBACK: 'Ta langue dapp (%s) n\'est pas dans le set de langues du chat — tu vois les traductions anglaises (fallback EN).',
    CHAT_LANGS_TITLE: 'Gérer le set de langues (taal-gate)',
    CHAT_LANGS_HINT: 'Coche les langues prises en charge par le chat. Les changements s\'appliquent immédiatement (override dans ce navigateur). Source : web/public/chat-langs.json (édité par Patrick). EN toujours activé (fallback).',
    CHAT_LANGS_RESET: 'Réinitialiser au défaut du fichier',
    CHAT_IDENTITY: 'Connecté en tant que %s (#%s) — les messages sont signés Ed25519 avec ta dapp-identity.',
    CHAT_NO_KEY: 'pas de clé de compte — reconnecte-toi avec mot de passe pour chatter',
    CHAT_KEY_ERR: 'erreur de clé',
    CHAT_XLATE_LOCAL: 'Traduction : local (SER5)',
    CHAT_XLATE_CLOUD: 'Traduction : Google (cloud)',
    CHAT_XLATE_MOCK: 'Traduction : mock (test)',
    CHAT_XLATE_DOWN: 'traduction indisponible',
    CHAT_XLATE_HOVER: 'traduit via local · %d ms',
  },
  es: {
    // --- MyChat (Abundomy-spoor) ---
    CHAT_NAV: 'Chat',
    CHAT_TITLE: 'MYCHAT — CHAT ABIERTO',
    CHAT_IDLE: 'no conectado',
    CHAT_CONNECTING: 'conectando…',
    CHAT_CONNECTED: 'conectado',
    CHAT_DISCONNECTED: 'desconectado — reconectando',
    CHAT_CONN_ERR: 'error de conexión',
    CHAT_ALONE: 'solo tú',
    CHAT_ME: 'tú',
    CHAT_TYPING: 'está escribiendo…',
    CHAT_SIGNED: 'firmado Ed25519 (dapp-identity)',
    CHAT_VERIFYING: 'verificando firma…',
    CHAT_VERIFIED: 'firma Ed25519 verificada ✓ (auténtico, de esta dapp-identity)',
    CHAT_INVALID_SIG: 'firma NO VÁLIDA ✗ — el mensaje no viene de la identity declarada (posible suplantación)',
    CHAT_UNSIGNED: 'no firmado (sin firma Ed25519)',
    CHAT_VERIFY_ERR: 'verificación fallida (error cripto)',
    CHAT_HISTORY: 'del historial',
    CHAT_PLACEHOLDER: 'Escribe un mensaje…',
    CHAT_SEND: 'Enviar',
    CHAT_HISTORY_SUMMARY: 'Historial en IPFS (abierto/transparente)',
    CHAT_HISTORY_DESC: 'Abierto/transparente — historial en texto plano + firmas Ed25519 en IPFS (CID inmutables). El CID PBFS2/IPFS-anchor es la fuente fijada autoritativa.',
    CHAT_PIN_IDLE: 'fijando en PBFS2/IPFS-anchor: pendiente…',
    CHAT_PINNED_PI: '✓ fijado en PBFS2/IPFS-anchor (legible públicamente vía pasarela IPFS)',
    CHAT_PIN_FAIL: '⚠ fijado en PBFS2/IPFS-anchor falló — ver error abajo',
    CHAT_GATE_OK: 'Idioma soportado: %s — los mensajes se traducen a este idioma.',
    CHAT_GATE_FALLBACK: 'Tu idioma dapp (%s) no está en el set de idiomas del chat — ves traducciones en inglés (fallback EN).',
    CHAT_LANGS_TITLE: 'Gestionar set de idiomas (taal-gate)',
    CHAT_LANGS_HINT: 'Marca qué idiomas admite el chat. Los cambios aplican al instante (override en este navegador). Fuente: web/public/chat-langs.json (editado por Patrick). EN siempre activo (fallback).',
    CHAT_LANGS_RESET: 'Restablecer al predeterminado del archivo',
    CHAT_IDENTITY: 'Conectado como %s (#%s) — los mensajes se firman Ed25519 con tu dapp-identity.',
    CHAT_NO_KEY: 'sin clave de cuenta — vuelve a iniciar sesión con contraseña para chatear',
    CHAT_KEY_ERR: 'error de clave',
    CHAT_XLATE_LOCAL: 'Traducción: local (SER5)',
    CHAT_XLATE_CLOUD: 'Traducción: Google (cloud)',
    CHAT_XLATE_MOCK: 'Traducción: mock (test)',
    CHAT_XLATE_DOWN: 'traducción no disponible',
    CHAT_XLATE_HOVER: 'traducido vía local · %d ms',
  },
  it: {
    // --- MyChat (Abundomy-spoor) ---
    CHAT_NAV: 'Chat',
    CHAT_TITLE: 'MYCHAT — CHAT APERTO',
    CHAT_IDLE: 'non connesso',
    CHAT_CONNECTING: 'connessione…',
    CHAT_CONNECTED: 'connesso',
    CHAT_DISCONNECTED: 'disconnesso — riconnessione',
    CHAT_CONN_ERR: 'errore di connessione',
    CHAT_ALONE: 'solo tu',
    CHAT_ME: 'tu',
    CHAT_TYPING: 'sta scrivendo…',
    CHAT_SIGNED: 'firmato Ed25519 (dapp-identity)',
    CHAT_VERIFYING: 'verifica della firma…',
    CHAT_VERIFIED: 'firma Ed25519 verificata ✓ (autentica, da questa dapp-identity)',
    CHAT_INVALID_SIG: 'firma NON VALIDA ✗ — il messaggio non viene dalla identity dichiarata (possibile impersonazione)',
    CHAT_UNSIGNED: 'non firmato (nessuna firma Ed25519)',
    CHAT_VERIFY_ERR: 'verifica fallita (errore crittografico)',
    CHAT_HISTORY: 'dalla cronologia',
    CHAT_PLACEHOLDER: 'Scrivi un messaggio…',
    CHAT_SEND: 'Invia',
    CHAT_HISTORY_SUMMARY: 'Cronologia su IPFS (aperto/trasparente)',
    CHAT_HISTORY_DESC: 'Aperto/trasparente — cronologia in chiaro + firme Ed25519 su IPFS (CID immutabili). Il CID PBFS2/IPFS-anchor è la fonte fissata autorevole.',
    CHAT_PIN_IDLE: 'fissaggio su PBFS2/IPFS-anchor: in attesa…',
    CHAT_PINNED_PI: '✓ fissato su PBFS2/IPFS-anchor (leggibile pubblicamente via gateway IPFS)',
    CHAT_PIN_FAIL: '⚠ fissaggio su PBFS2/IPFS-anchor fallito — vedi errore sotto',
    CHAT_GATE_OK: 'Lingua supportata: %s — i messaggi sono tradotti in questa lingua.',
    CHAT_GATE_FALLBACK: 'La tua lingua dapp (%s) non è nel set di lingue della chat — vedi traduzioni in inglese (fallback EN).',
    CHAT_LANGS_TITLE: 'Gestisci set di lingue (taal-gate)',
    CHAT_LANGS_HINT: 'Spunta quali lingue supporta la chat. Le modifiche si applicano subito (override in questo browser). Fonte: web/public/chat-langs.json (modificata da Patrick). EN sempre attivo (fallback).',
    CHAT_LANGS_RESET: 'Ripristina al default del file',
    CHAT_IDENTITY: 'Connesso come %s (#%s) — i messaggi sono firmati Ed25519 con la tua dapp-identity.',
    CHAT_NO_KEY: 'nessuna chiave account — riaccedi con password per chattare',
    CHAT_KEY_ERR: 'errore di chiave',
    CHAT_XLATE_LOCAL: 'Traduzione: locale (SER5)',
    CHAT_XLATE_CLOUD: 'Traduzione: Google (cloud)',
    CHAT_XLATE_MOCK: 'Traduzione: mock (test)',
    CHAT_XLATE_DOWN: 'traduzione non disponibile',
    CHAT_XLATE_HOVER: 'tradotto via locale · %d ms',
  },
  hu: {
    // --- MyChat (Abundomy-spoor) ---
    CHAT_NAV: 'Chat',
    CHAT_TITLE: 'MYCHAT — NYITOTT CHAT',
    CHAT_IDLE: 'nincs kapcsolat',
    CHAT_CONNECTING: 'csatlakozás…',
    CHAT_CONNECTED: 'csatlakozva',
    CHAT_DISCONNECTED: 'bontva — újracsatlakozás',
    CHAT_CONN_ERR: 'kapcsolati hiba',
    CHAT_ALONE: 'csak te',
    CHAT_ME: 'te',
    CHAT_TYPING: 'gépel…',
    CHAT_SIGNED: 'Ed25519-aláírva (dapp-identity)',
    CHAT_VERIFYING: 'aláírás ellenőrzése…',
    CHAT_VERIFIED: 'Ed25519-aláírás ellenőrizve ✓ (hiteles, ettől a dapp-identitytól)',
    CHAT_INVALID_SIG: 'ÉRVÉNYTELEN aláírás ✗ — az üzenet nem a hivatkozott identitytól jön (lehetséges megszemélyesítés)',
    CHAT_UNSIGNED: 'nincs aláírva (nincs Ed25519-aláírás)',
    CHAT_VERIFY_ERR: 'ellenőrzés sikertelen (kripto-hiba)',
    CHAT_HISTORY: 'az előzményekből',
    CHAT_PLACEHOLDER: 'Írj egy üzenetet…',
    CHAT_SEND: 'Küldés',
    CHAT_HISTORY_SUMMARY: 'Előzmények az IPFS-en (nyílt/átlátható)',
    CHAT_HISTORY_DESC: 'Nyílt/átlátható — előzmények plaintext + Ed25519-aláírások az IPFS-en (változatlan CID-k). A PBFS2/IPFS-anchor CID a mérvadó rögzített forrás.',
    CHAT_PIN_IDLE: 'rögzítés a PBFS2/IPFS-anchorra: függőben…',
    CHAT_PINNED_PI: '✓ rögzítve a PBFS2/IPFS-anchoron (nyilvánosan olvasható IPFS-átjárón)',
    CHAT_PIN_FAIL: '⚠ rögzítés a PBFS2/IPFS-anchoron sikertelen — lásd a hibát lent',
    CHAT_GATE_OK: 'Támogatott nyelv: %s — az üzenetek erre a nyelvre lesznek fordítva.',
    CHAT_GATE_FALLBACK: 'A dapp-nyelved (%s) nincs a chat nyelvi setjében — angol fordításokat látsz (EN-fallback).',
    CHAT_LANGS_TITLE: 'Nyelvi set kezelése (taal-gate)',
    CHAT_LANGS_HINT: 'Jelöld be, mely nyelveket támogatja a chat. A változtatások azonnal érvényesek (felülbírálás ebben a böngészőben). Forrás: web/public/chat-langs.json (Patrick szerkeszti). EN mindig be (fallback).',
    CHAT_LANGS_RESET: 'Visszaállítás a fájl alapértelmezésére',
    CHAT_IDENTITY: 'Bejelentkezve mint %s (#%s) — az üzenetek Ed25519-aláírással lesznek ellátva a dapp-identity-val.',
    CHAT_NO_KEY: 'nincs fiókkulcs — jelentkezz be újra jelszóval a chateléshez',
    CHAT_KEY_ERR: 'kulcs-hiba',
    CHAT_XLATE_LOCAL: 'Fordítás: helyi (SER5)',
    CHAT_XLATE_CLOUD: 'Fordítás: Google (felhő)',
    CHAT_XLATE_MOCK: 'Fordítás: mock (teszt)',
    CHAT_XLATE_DOWN: 'fordítás nem elérhető',
    CHAT_XLATE_HOVER: 'lefordítva helyi úton · %d ms',
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
 * Ronde land-vlag als inline-SVG (1-op-1 uit het origineel `getFlagSVG`). De bron
 * gebruikt een vaste clip-id `c`; we maken die uniek per gebruik (`uid`) zodat meerdere
 * vlaggen op één pagina niet botsen.
 */
export function getFlag(code, uid) {
  const svg = FLAGS[code] || FLAGS.en || ''
  const id = 'c_' + (uid || code)
  return svg.replace(/id="c"/g, `id="${id}"`).replace(/url\(#c\)/g, `url(#${id})`)
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

