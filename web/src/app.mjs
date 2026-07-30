/**
 * Abundomy browser-SPA. Draait de hele dapp client-side: identiteit, replicatie,
 * saldo, proposals, betalingen en keten-export — herbruikt de portable kern uit
 * `../../src/*`. Connectiviteit via de relay (zie `web/relay.mjs`).
 *
 * Inloggen kan op drie manieren:
 *  - seed-login: nieuw account via zijn seed (usersId wordt opgezocht via de pubkey)
 *  - signup: nieuw account aanmaken met e-mailverificatie (`/api/email/*`)
 */
import { multiaddr } from '@multiformats/multiaddr'
import { startBrowserNode } from './ipfs-browser.mjs'
import { openStores, closeStores } from '../../src/stores.mjs'
import { deriveCommunityKey, decryptUserProfile } from '../../src/crypto.mjs'
import { availableCoins, joinedDate, parseSqlDate } from '../../src/ledger.mjs'
import { createProposal, payProposal } from '../../src/payments.mjs'
import { signup, changePassword, rekeyAuth, deriveAccountKey, updateProfile, repairIdentity } from '../../src/identity.mjs'
import { createKeystore, openKeystore, validatePassword, generateRecoveryCode, formatRecoveryCode, normalizeRecoveryCode } from '../../src/auth.mjs'
import { exportUserChain } from '../../src/export.mjs'
import { addToList, removeFromList, getList, BLACKLIST, WHITELIST } from '../../src/lists.mjs'
import { COMMUNITY_SECRET, DECAY_RATE } from '../../src/config.mjs'
import { t, getLang, setLang, onLangChange, loadI18n, applyStaticI18n, getFlag, hasLang, LANGUAGES } from './i18n.mjs'

const $ = (id) => document.getElementById(id)
const log = (...a) => {
  const line = a.join(' ')
  $('log').textContent += line + '\n'; $('log').scrollTop = 1e9
  // Spiegel de laatste regel naar het zichtbare login-statusveld (#log zit in de
  // dapp-sectie en is op het loginscherm onzichtbaar → anders lijkt er "niets" te gebeuren).
  try { const ri = $('relayInfo'); if (ri && !$('login').classList.contains('hidden')) ri.textContent = line } catch {}
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/**
 * Absolute mailer-API-basis. De app draait op IPFS (dweb.link/IPNS), de mailer is een aparte
 * server-dienst; daarom roepen we 'm op een ABSOLUTE URL aan (uit relay.json `api`, bv. de
 * Hetzner-sslip.io), niet relatief. Leeg → relatief (lokale dev met nginx-proxy). Gecachet.
 */
let _relayCfg
async function relayCfg () {
  if (!_relayCfg) _relayCfg = await (await fetch('relay.json')).json()
  return _relayCfg
}
/**
 * De bekende nodes als `{name, addr, api}`. Nieuw schema: een `nodes`-array. De oude
 * losse velden (`addr`/`replicator`/`api`) blijven meedoen zodat een gecachte bundel én
 * een oude relay.json blijven werken; dubbele adressen vallen weg.
 */
async function relayNodes () {
  const r = await relayCfg()
  const legacy = [r.addr, r.replicator].filter(Boolean).map((addr) => ({ name: 'legacy', addr, api: r.api || '' }))
  const seen = new Set()
  return [...(Array.isArray(r.nodes) ? r.nodes : []), ...legacy]
    .filter((n) => n?.addr && !seen.has(n.addr) && seen.add(n.addr))
}
/**
 * Roep een server-API (mailer) aan op de eerste node die antwoordt. De app draait op
 * IPFS (dweb.link/IPNS) en de API is een aparte server-dienst, dus de URL is ABSOLUUT.
 * Alleen bij een NETWERKfout schuiven we door naar de volgende node — een 4xx/5xx is een
 * echt antwoord en wordt teruggegeven. Geen enkele node bereikbaar → laatste fout gooien.
 * Lege api (lokale dev met nginx-proxy) betekent: relatief.
 */
async function apiFetch (path, init) {
  const bases = [...new Set((await relayNodes().catch(() => [])).map((n) => n.api || ''))]
  if (!bases.length) bases.push('')
  let last
  for (const base of bases) {
    try { return await fetch(base + path, init) } catch (e) { last = e }
  }
  throw last ?? new Error('geen node bereikbaar')
}
/**
 * Bevestig e-mailbezit met de gemailde 6-cijferige CODE (geen klikbare link → veel betere
 * mail-aflevering; Hotmail/Outlook dropte de oude sslip.io-link-mails). Throwt bij annuleren
 * of na te veel mislukte pogingen.
 */
async function confirmEmailByCode (email, pubkey) {
  return new Promise((resolve, reject) => {
    const ov = document.createElement('div')
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.65);display:flex;align-items:center;justify-content:center;z-index:99999;padding:16px'
    ov.innerHTML = '<div style="background:#fff;color:#111;max-width:360px;width:100%;padding:22px;border-radius:14px;font-family:sans-serif;text-align:center;box-shadow:0 10px 40px rgba(0,0,0,.4)">' +
      '<p style="margin:0 0 4px;font-weight:bold">Bevestig je e-mailadres</p>' +
      '<p style="margin:0 0 12px;color:#666;font-size:13px">Vul de 6-cijferige code uit je e-mail in (kijk ook in spam).</p>' +
      '<input id="__abCode" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000" style="font-size:24px;letter-spacing:8px;text-align:center;width:7em;padding:10px;border:1px solid #ccc;border-radius:8px" />' +
      '<p id="__abCodeMsg" style="color:#b00020;min-height:1.2em;margin:10px 0 4px;font-size:13px"></p>' +
      '<div><button id="__abCodeOk" style="padding:10px 18px;border:0;border-radius:8px;background:#2b7;color:#fff;font-size:15px;cursor:pointer">Bevestigen</button>' +
      '<button id="__abCodeCancel" style="padding:10px 18px;margin-left:8px;border:1px solid #ccc;border-radius:8px;background:#f4f4f4;cursor:pointer">Annuleer</button></div></div>'
    document.body.appendChild(ov)
    const inp = ov.querySelector('#__abCode')
    const msg = (m) => { ov.querySelector('#__abCodeMsg').textContent = m }
    const ok = ov.querySelector('#__abCodeOk')
    setTimeout(() => inp.focus(), 50)
    const close = () => ov.remove()
    ov.querySelector('#__abCodeCancel').onclick = () => { close(); reject(new Error('e-mailverificatie geannuleerd')) }
    ok.onclick = async () => {
      const code = (inp.value || '').trim()
      if (!code) { msg('Vul de code in.'); return }
      ok.disabled = true; msg('Code controleren…')
      try {
        const r = await apiFetch('/api/email/confirm', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email, code, pubkey }),
        })
        const j = await r.json().catch(() => ({}))
        if (r.ok && j.verified) { close(); resolve(true); return }
        msg('Code klopt niet of is verlopen — probeer opnieuw.')
      } catch (e) { msg('Fout: ' + e.message) }
      ok.disabled = false
    }
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok.click() })
  })
}
/** ISO-datum (JJJJ-MM-DD) → Nederlands DD-MM-JJJJ. */
const formatDateNL = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || ''); return m ? `${m[3]}-${m[2]}-${m[1]}` : (iso || '—') }

let node, stores, communityKey, me, myProfile

// Benoemde keuzes (1-op-1 uit de oude 1CoinH-site; de opgeslagen waarde blijft de code/index).
const HAIR_COLORS = ['White', 'Ginger Red', 'Auburn', 'Blond', 'Light Chestnut', 'Copper', 'Light Blond', 'Chestnut Brown', 'Silver', 'Medium Blond', 'Light Brown', 'Titan', 'Dark Blond', 'Medium Brown', 'Gray', 'Gold Blond', 'Dark Brown', 'Black', 'Strawberry Blond', 'No Hair']
const EYE_COLORS = ['Amber', 'Blue', 'Brown', 'Gray', 'Green', 'Hazel', 'Red', 'Blue Gray', 'Blue Green', 'Green Gray', 'Green Brown', 'Prosthesis']
function fillSelect(id, labels, def) {
  const sel = $(id); if (!sel) return
  sel.innerHTML = ''
  labels.forEach((label, i) => {
    const o = document.createElement('option'); o.value = i; o.textContent = label
    if (i === def) o.selected = true
    sel.append(o)
  })
}
// Vertaalde labels (de opgeslagen waarde blijft de index/code). Bouwen uit t() zodat
// een taalwissel ze meteen kan verversen; de array-lengtes komen uit de codelijsten boven.
const hairLabels = () => HAIR_COLORS.map((_, i) => t('HC_' + i))
const eyeLabels = () => EYE_COLORS.map((_, i) => t('EC_' + i))
const genderLabels = () => ['SU_ML', 'SU_FM', 'SU_OT'].map((k) => t(k))
const monthsLong = () => Array.from({ length: 12 }, (_, i) => t('ML_' + (i + 1)))
const monthsShort = () => Array.from({ length: 12 }, (_, i) => t('M_' + (i + 1)))

function populateSelects() {
  fillSelect('suHair', hairLabels(), 17)   // default: Black
  fillSelect('suLeftEye', eyeLabels(), 2)  // default: Brown
  fillSelect('suRightEye', eyeLabels(), 2)
}

/** Herlabel een al-gevulde <select> bij taalwissel, met behoud van de selectie. */
function relabelSelect(id, labels) {
  const sel = $(id); if (!sel) return
  fillSelect(id, labels, Number(sel.value) || 0)
}

async function waitFor(fn, label, timeout = 40_000) {
  const start = Date.now()
  for (;;) {
    if (await fn()) return
    if (Date.now() - start > timeout) throw new Error(`timeout: ${label}`)
    await sleep(300)
  }
}

/**
 * Geef replicatie even de tijd, zonder te falen bij een lege store. Stopt vroeg zodra
 * er data binnenkomt (eerste 'update'), anders na `maxMs`. Nodig omdat de users-store
 * legitiem leeg kan zijn (bv. na een schone start) — dan bestaat er geen "length > 0".
 */
async function settleSync(db, maxMs = 6000) {
  if ((await db.all()).length > 0) return
  await new Promise((resolve) => {
    let done = false
    const finish = () => { if (done) return; done = true; clearTimeout(t); try { db.events.off('update', onUpdate) } catch {} resolve() }
    const onUpdate = () => finish()
    const t = setTimeout(finish, maxMs)
    try { db.events.on('update', onUpdate) } catch { finish() }
  })
}

/** Dial het anker (blocks) + de replicator (OrbitDB-heads) en wacht op een pubsub-peer.
 *  Geeft de lijst gedialede multiaddrs terug. De replicator-wss is de niet-gelimiteerde
 *  verbinding waarover OrbitDB's head-exchange loopt; het anker levert blocks via bitswap. */
async function dialRelay(n) {
  const addrs = (await relayNodes()).map((x) => multiaddr(x.addr))
  await Promise.allSettled(addrs.map((ma) => n.ipfs.libp2p.dial(ma)))
  await waitFor(() => n.ipfs.libp2p.services.pubsub.getPeers().length > 0, 'relay-peer')
  return addrs
}

// Eén gedeelde node voor de hele SPA. De OrbitDB/node-identiteit is sinds de
// seed-afgeleide accountidentiteit IRRELEVANT voor de beveiliging (stores zijn
// wildcard-write; ondertekening gaat via deriveAccountKey). Dus geen aparte
// gast-/sessie-node meer per gebruiker — dat scheelt twee koude syncs per login.
// De node-seed staat vast per browser (localStorage) zodat de IndexedDB-blockstore
// gecached blijft en vervolg-logins snel zijn.
const NODE_SEED_KEY = 'abundomy-node-seed'
function getNodeSeed() {
  try {
    let s = localStorage.getItem(NODE_SEED_KEY)
    if (!s) { s = 'abundomy-node-' + crypto.randomUUID(); localStorage.setItem(NODE_SEED_KEY, s) }
    return s
  } catch { return 'abundomy-node-' + crypto.randomUUID() }
}

let sessionPromise = null
/** Start de gedeelde node precies één keer (idempotent), ook bij gelijktijdige aanroepen. */
function ensureSession() {
  if (!sessionPromise) sessionPromise = openSession(getNodeSeed())
  return sessionPromise
}

/** Start node + verbind met relay + open/sync de stores. Zet de globals node/stores/communityKey. */
async function openSession(seed) {
  log(`Node starten…`)
  node = await startBrowserNode({ seed })
  communityKey = await deriveCommunityKey(COMMUNITY_SECRET)

  log('Verbinden met anker + replicator…')
  const relayMas = await dialRelay(node)
  const pubsub = node.ipfs.libp2p.services.pubsub

  // Houd de verbinding(en) levend (floodsub is fire-and-forget).
  setInterval(async () => {
    if (pubsub.getPeers().length === 0) {
      log('geen pubsub-peer — opnieuw verbinden…')
      for (const ma of relayMas) { try { await node.ipfs.libp2p.dial(ma) } catch {} }
    }
  }, 4000)

  log('Stores openen + synchroniseren…')
  stores = await openStores(node.orbitdb, { write: ['*'] })
  await settleSync(stores.users)        // mag leeg zijn (schone start / na wipe)
  await settleSync(stores.transactions) // heeft normaal data, maar faalt niet bij leeg
}

/** Toon het dashboard + zet de live-rendering aan (gedeeld door alle login-paden). */
async function finishLogin() {
  myProfile = await decryptUserProfile((await stores.users.get(me)).value, communityKey)
  // Onthoud de sessie zodat een (her)laden ingelogd blijft → "Ververs" kan veilig
  // een verse node-sync doen via reload (de betrouwbaarste manier om nieuwe data te halen).
  try { sessionStorage.setItem('abundomy-me', String(me)) } catch {}
  log(`Ingelogd als ${myProfile.usersName} (#${me}).`)

  for (const [name, db] of Object.entries(stores)) {
    db.events.on('update', () => { log(`↻ update in '${name}'`); render().catch(() => {}) })
  }
  const lp = node.ipfs.libp2p
  lp.addEventListener('connection:open', () => log(`+ verbonden (${lp.getConnections().length} connectie(s))`))
  // SNEL HERSTEL: zodra een verbinding wegvalt, meteen (gedebounced) een verse head-
  // uitwisseling forceren i.p.v. wachten op de periodieke tik → gemiste verzoeken komen
  // binnen enkele seconden binnen i.p.v. pas na de volgende cyclus. `resyncing`-guard
  // voorkomt dat onze eigen hangUp (in resyncStores) een herstel-lus triggert.
  let resyncTimer = null
  const scheduleResync = (delay = 800) => {
    if (resyncTimer || resyncing) return
    resyncTimer = setTimeout(() => { resyncTimer = null; resyncStores().catch(() => {}) }, delay)
  }
  lp.addEventListener('connection:close', () => { log(`- connectie weg (${lp.getConnections().length} over)`); scheduleResync() })
  setInterval(() => render().catch(() => {}), 2500)
  // Vangnet voor een HALF-DODE relay-connectie (telt nog als 'verbonden', dus de keepalive
  // grijpt niet in): periodiek de verbinding vernieuwen → verse head-uitwisseling haalt
  // gemiste entries alsnog op. Bewezen met een geïsoleerde 3-node-reproductie (writer/
  // receiver/relay): een gemiste entry wordt na hangUp+redial ingehaald.
  setInterval(() => resyncStores().catch(() => {}), 15000)

  $('app-header').classList.remove('hidden')
  $('topNav').classList.add('hidden')
  for (const id of ['login', 'signup', 'resetCard']) $(id).classList.add('hidden')
  $('goDashboard').classList.add('hidden')
  location.hash = '#/' // punt 02: na login altijd dashboard (1coinh index.php?login=success), ook als je op #/profile herlaadde
  route() // toont de juiste view + rendert (header + inhoud)
}

/** Wachtwoord wijzigen (alleen de ingelogde eigenaar). */
async function doChangePassword() {
  const info = (m) => { $('changePwdInfo').textContent = m }
  const btn = $('changePwdBtn'); btn.disabled = true
  try {
    const current = $('cpCurrent').value
    const next = $('cpNew').value
    if (!current) throw new Error('vul je huidige wachtwoord in')
    if (next !== $('cpNew2').value) throw new Error('de nieuwe wachtwoorden komen niet overeen')
    info('Wachtwoord wijzigen…')
    await changePassword({ stores, usersId: me, currentPassword: current, newPassword: next })
    for (const id of ['cpCurrent', 'cpNew', 'cpNew2']) $(id).value = ''
    info('Wachtwoord gewijzigd ✓ — gebruik voortaan je nieuwe wachtwoord.')
  } catch (e) {
    info('FOUT: ' + e.message)
  } finally {
    btn.disabled = false
  }
}

/** Zoek een user-record op gebruikersnaam (leesbaar) of e-mail (versleuteld → ontsleutel). */
async function findUserByIdentifier(records, identifier, commKey) {
  const id = identifier.toLowerCase()
  const byUid = records.find((u) => (u.usersUid || '').toLowerCase() === id)
  if (byUid) return byUid
  for (const u of records) {
    try {
      const p = await decryptUserProfile(u, commKey)
      if ((p.usersEmail || '').toLowerCase() === id) return u
    } catch {}
  }
  return null
}

async function loginWithPassword() {
  const ident = $('loginId').value.trim()
  const pwd = $('loginPwd').value
  if (!ident || !pwd) { log('Geef gebruiker/e-mail en wachtwoord op.'); return }
  $('loginBtn').disabled = true
  try {
    log('Verbinden…')
    await ensureSession()
    log('Account opzoeken…')
    // Poll tot dit account is gerepliceerd (kan bij een koude node even duren).
    let rec = null
    await waitFor(async () => {
      rec = await findUserByIdentifier((await stores.users.all()).map((e) => e.value), ident, communityKey)
      return !!rec
    }, 'account-lookup', 30000).catch(() => {})
    if (!rec) throw new Error('geen account met die gebruiker/e-mail')
    if (!rec.auth) throw new Error('dit account heeft nog geen wachtwoord — meld je aan met je e-mailadres om er een in te stellen')
    const seed = await openKeystore(rec.auth, pwd) // verifieert het wachtwoord (gooit 'verkeerd wachtwoord')
    me = rec.usersId
    // Self-heal: door historische usersId-collisions kan dit doc inconsistent zijn (pubkey/
    // claim van een andere identiteit dan auth/recovery) → reset kapot. Repareer met de seed
    // die dit wachtwoord oplevert, en toon de NIEUWE herstelcode prominent (bewaren!).
    try {
      const fix = await repairIdentity({ stores, seed, usersId: me })
      if (fix.repaired) {
        log('⚠ Account-identiteit hersteld na historische overschrijving.')
        log('⚠ NIEUWE HERSTELCODE — bewaar deze (nodig voor wachtwoord-reset): ' + fix.recoveryCode)
        try { alert('Je account is automatisch hersteld.\n\nNIEUWE HERSTELCODE — bewaar deze goed; je hebt \'m nodig om je wachtwoord te resetten:\n\n' + fix.recoveryCode) } catch {}
      }
    } catch (e) { log('identiteit-herstel overgeslagen: ' + e.message) }
    await finishLogin()
  } catch (err) {
    log('FOUT: ' + err.message)
    $('loginBtn').disabled = false
  }
}

/** Signup: e-mail verifiëren (uniek), daarna account + wachtwoord-keystore aanmaken. */
async function doSignup() {
  const btn = $('signupBtn'); btn.disabled = true
  const info = (m) => { $('signupInfo').textContent = m }
  try {
    const email = $('suEmail').value.trim()
    if (!email) throw new Error('e-mailadres is vereist')
    const uid = $('suUid').value.trim()
    if (uid.length <= 3) throw new Error('gebruikersnaam moet langer dan 3 tekens zijn')
    const pwd = $('suPwd').value
    const pwdErr = validatePassword(pwd)
    if (pwdErr) throw new Error(pwdErr)
    if (pwd !== $('suPwd2').value) throw new Error('de wachtwoorden komen niet overeen')
    const birthday = $('suBirthday').value // <input type=date> → '' of 'JJJJ-MM-DD'
    const profile = {
      usersEmail: email,
      usersName: $('suName').value.trim(),
      usersUid: uid,
      birthday,
      height: $('suHeight').value.trim(),
      gender: Number($('suGender').value) || 0,
      hair: Number($('suHair').value) || 0,
      leftEye: Number($('suLeftEye').value) || 0,
      rightEye: Number($('suRightEye').value) || 0,
      specialFeatures: $('suSpecial').value.trim(),
      image: signupImage, // gekozen profielfoto (data-URI) of ''
      language: 'en',
    }

    // Willekeurige account-seed = de enige bron van de keypair; wordt zo meteen met het
    // wachtwoord versleuteld in een keystore (de seed zelf verlaat dit tabblad nooit).
    // Los van de node-seed: de node-identiteit doet niet mee aan de accountbeveiliging.
    const seed = 'abundomy-' + crypto.randomUUID()
    // Herstelcode voor de e-mail-herstelkluis: gaat per e-mail mee, niet op het scherm.
    const recoveryRaw = generateRecoveryCode()

    info('Verbinden…')
    await ensureSession()
    const pubkey = (await deriveAccountKey(seed)).pubkey

    info('Verificatiemail aanvragen…')
    const r = await apiFetch('/api/email/start', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, pubkey, recoveryCode: formatRecoveryCode(recoveryRaw) }),
    })
    if (r.status === 409) throw new Error('dit e-mailadres is al in gebruik')
    if (!r.ok) throw new Error('verificatie-aanvraag mislukt — probeer het nog eens')
    info('✉ Check je e-mail — vul de verificatiecode in (kijk ook in spam).')
    await confirmEmailByCode(email, pubkey, info)

    info('E-mail bevestigd ✓ — wachtwoord-keystore + herstelkluis aanmaken…')
    const auth = await createKeystore(seed, pwd)
    const recovery = await createKeystore(seed, recoveryRaw)
    const doc = await signup({ stores, seed, profile, communityKey, auth, recovery })
    me = doc.usersId
    info(`Account #${me} aangemaakt ✓ — log voortaan in met je gebruikersnaam en wachtwoord. ` +
      `De herstelcode staat in je welkomstmail.`)
    $('goDashboard').classList.remove('hidden')
    clearSignupForm()  // Punt 04-24-07: form leegmaken na succesvolle account-aanmaak
  } catch (e) {
    info('FOUT: ' + e.message)
    btn.disabled = false
  }
}

/**
 * Vernieuw de relay-verbinding en haal gemiste data op. Een lange sessie kan een
 * "half-dode" relay-connectie krijgen (floodsub denkt dat 'ie verbonden is, maar er
 * gaat niets meer doorheen) — dan mist de live-push én helpt her-subscriben niet.
 * Een verse verbinding (sluiten + opnieuw dialen) triggert dezelfde head-uitwisseling
 * als een nieuwe login, waardoor gemiste entries (bv. een betaalverzoek) binnenkomen.
 */
let resyncing = false
async function resyncStores() {
  if (resyncing) return
  resyncing = true
  try {
    const lp = node.ipfs.libp2p
    const relayAddrs = (await relayNodes()).map((x) => x.addr)
    const relayMas = relayAddrs.map((a) => multiaddr(a))
    // Peer-ID uit de adres-string halen (multiaddr.getPeerId() bestaat niet op de
    // gebundelde versie → wierp elke 20s een fout waardoor dit vangnet nooit liep).
    const relayPeers = new Set(relayAddrs.map((a) => a.split('/p2p/').pop()).filter(Boolean))
    // BROWSER-GEÏNITIEERDE CATCH-UP. Browsers zijn NIET dialbaar → de replicator kan gemiste
    // OrbitDB-heads niet naar ons PUSHEN. OrbitDB v4 z'n catch-up (sync.js handlePeerSubscribed
    // → dialProtocol) loopt alléén wanneer WIJ de replicator op een VERSE verbinding (her)dialen.
    // `db.sync.stop()/start()` (oude aanpak) helpt niet: re-subscriben leunt op een terug-dial
    // die bij browsers faalt. Daarom forceren we een echte herverbinding: hang de bestaande
    // relay-connectie op — dit wist de peer uit OrbitDB's sync-set via 'peer:disconnect' — en
    // dial opnieuw → triggert een UITGAANDE head-uitwisseling die gemiste verzoeken alsnog
    // ophaalt. Zelfcorrigerend: mist deze cyclus iets in het korte herverbind-venster, dan
    // haalt de volgende 'm op. Live pubsub blijft de snelle hoofdroute; dit is het vangnet.
    for (const c of lp.getConnections()) {
      if (relayPeers.has(c.remotePeer.toString())) { try { await lp.hangUp(c.remotePeer) } catch {} }
    }
    for (const ma of relayMas) { try { await lp.dial(ma) } catch {} }
    await waitFor(() => lp.services.pubsub.getPeers().length > 0, 'relay-resync', 12000).catch(() => {})
    await sleep(1500) // head-uitwisseling tijd geven
  } catch (e) { log('↻ resync-fout: ' + e.message) }
  finally { resyncing = false }
  await render().catch(() => {})
}

// ============================ NAVIGATIE (hash-router) ============================
// De SPA toont één <section class="view"> tegelijk. route() leest location.hash,
// toont de juiste view en laat de dispatcher render() die view (her)tekenen.
let currentView = 'home'
let currentParams = {}

const VIEW_NAMES = { '': 'home', home: 'home', transactions: 'transactions', tx: 'txdetail', profile: 'profile', search: 'search', request: 'request' }
const VIEWS = ['home', 'transactions', 'txdetail', 'profile', 'search', 'request']

function parseHash() {
  const h = (location.hash || '#/').replace(/^#\/?/, '')
  const parts = h.split('/').filter(Boolean) // '#/transactions/5' → ['transactions','5']
  return { name: parts[0] || 'home', arg: parts[1] }
}

function route() {
  if (me == null || !stores) return
  const { name, arg } = parseHash()
  const view = VIEW_NAMES[name] || 'home'
  currentView = view
  currentParams = { id: arg, tid: arg }
  for (const v of VIEWS) {
    $('view-' + v)?.classList.toggle('hidden', v !== view)
  }
  render().catch(() => {})
}

// ============================ HELPERS ============================
/** Bedrag als "1,000.00" (zoals het origineel: number_format met 2 decimalen). */
const formatCoins = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
/** 10-cijferig gegroepeerd "X XXX XXX XXX" (zoals header.php). */
function formatDisplayNum(id) {
  const p = String(id).padStart(10, '0')
  return `${p.slice(0, 1)} ${p.slice(1, 4)} ${p.slice(4, 7)} ${p.slice(7, 10)}`
}

/**
 * Placeholder-avatar (er is nog geen fotodata — backlog #11). Gekleurde cirkel
 * met de eerste letter van de naam; kleur uit het gebruikers-id voor onderscheid.
 * Centrale plek zodat #11 hier later echte beelden kan invoegen.
 */
function avatarFor(profile) {
  const img = profile?.image
  if (typeof img === 'string' && img.startsWith('data:image')) return img // echte foto
  const name = (profile?.usersName || '?').trim()
  const initial = (name[0] || '?').toUpperCase()
  const id = Number(profile?.usersId ?? 0)
  const hue = (id * 47) % 360
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="hsl(${hue},45%,32%)"/><text x="50" y="50" dy=".35em" font-family="sans-serif" font-size="46" fill="#fff" text-anchor="middle">${initial}</text></svg>`
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg)
}

/**
 * Een gekozen afbeeldingsbestand → vierkante, midden-bijgesneden JPEG data-URI
 * (256×256). Klein genoeg voor OrbitDB/IPFS (~10–25 kB) en sluit aan op de ronde
 * avatars (object-fit: cover). Equivalent van het origineel `image.php`, vereenvoudigd.
 */
function fileToAvatarDataURL(file, size = 256) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('kan bestand niet lezen'))
    reader.onload = () => {
      const img = new Image()
      img.onerror = () => reject(new Error('geen geldige afbeelding'))
      img.onload = () => {
        const canvas = document.createElement('canvas')
        canvas.width = size; canvas.height = size
        const ctx = canvas.getContext('2d')
        const scale = Math.max(size / img.width, size / img.height) // cover
        const w = img.width * scale, h = img.height * scale
        ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h)
        resolve(canvas.toDataURL('image/jpeg', 0.82))
      }
      img.src = reader.result
    }
    reader.readAsDataURL(file)
  })
}

const txDate = (s) => parseSqlDate(s)
/** "06 jul 14:30" (lijst). UTC-getters → toont de opgeslagen wandklok-tijd. */
function fmtRowDate(s) {
  const d = txDate(s)
  return `${String(d.getUTCDate()).padStart(2, '0')} ${monthsShort()[d.getUTCMonth()]} ` +
    `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}
/** "6 jul 2024 | 14:30" (detail). */
function fmtDetailDate(s) {
  const d = txDate(s)
  return `${d.getUTCDate()} ${monthsShort()[d.getUTCMonth()]} ${d.getUTCFullYear()} | ` +
    `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

// ============================ DISPATCHER ============================
/** Werk de header bij + (her)teken de actieve view. Door alle live-loops aangeroepen. */
async function render() {
  if (me == null || !stores) return
  await renderHeader().catch(() => {})
  try {
    if (currentView === 'transactions') await renderTransactions(currentParams)
    else if (currentView === 'txdetail') await renderTxDetail(currentParams)
    else if (currentView === 'profile') await renderProfile(currentParams)
    else if (currentView === 'search') await renderSearch()
    else if (currentView === 'request') await renderRequest(currentParams)
    else await renderHome()
  } catch (e) { log('render-fout: ' + e.message) }
}

/** Vaste header: logo · gegroepeerd id + saldo · avatar. */
async function renderHeader() {
  if (me == null || !stores) return
  const txs = (await stores.transactions.all()).map((e) => e.value)
  const usersOld = (await stores.usersOld.all()).map((e) => e.value)
  const myDoc = (await stores.users.get(me))?.value
  const bal = availableCoins({ joined: joinedDate(myDoc, usersOld), transactions: txs, userId: me, asOf: new Date() })
  $('header-balance').textContent = `${formatCoins(bal)} ᕫ`
  $('headerNum').textContent = formatDisplayNum(me)
  $('headerAvatar').src = avatarFor({ ...myProfile, usersId: me })
}

// ============================ HOME (openstaande verzoeken) ============================
// Twee secties, 1-op-1 uit index.php getProposalsHTML:
//  - MIJN VERZOEKEN: proposals waar ik ontvanger ben (ik vroeg; wacht op betaling) → annuleren
//  - TE BETALEN:     proposals waar ik gever ben (iemand vroeg; ik bevestig/betaal of annuleer)
async function renderHome() {
  const users = (await stores.users.all()).map((e) => e.value)
  const profilesById = new Map(users.map((u) => [u.usersId, u]))
  const proposals = (await stores.proposals.all()).map((e) => e.value)
  // Handhaving: verzoeken van geblokkeerde (of buiten de witte lijst vallende) partners verbergen.
  const wl = Number(myProfile.useWhitelist) === 1
  const blocks = new Set(await getList({ stores, ownerId: me, listType: BLACKLIST }))
  const allows = new Set(await getList({ stores, ownerId: me, listType: WHITELIST }))
  const allowed = (id) => id === me || (wl ? allows.has(id) : !blocks.has(id))
  const myRequests = proposals.filter((p) => p.receiver === me && allowed(p.giver))
  const toPay = proposals.filter((p) => p.giver === me && allowed(p.receiver))

  // Diagnostiek (in de disclosure).
  const lp = node.ipfs.libp2p
  $('status').textContent = `peers: ${lp.getConnections().length} · pubsub-peers: ${lp.services.pubsub.getPeers().length} · ` +
    `users: ${users.length} · transacties: ${(await stores.transactions.all()).length} · proposals: ${proposals.length}`

  // Partnerprofielen ontsleutelen (voor avatar + naam-fallback).
  const partnerIds = new Set([...myRequests.map((p) => p.giver), ...toPay.map((p) => p.receiver)])
  const partner = new Map()
  for (const id of partnerIds) {
    const doc = profilesById.get(id)
    partner.set(id, doc ? await safeProfile(doc) : { usersId: id, usersName: `#${id}` })
  }

  // MIJN VERZOEKEN
  const mr = $('myRequests'); mr.innerHTML = ''
  for (const p of myRequests) mr.append(buildProposalRow(p, partner.get(p.giver), p.giver, 'mine'))

  // TE BETALEN
  $('toPaySection').classList.toggle('hidden', toPay.length === 0)
  const tp = $('toPay'); tp.innerHTML = ''
  for (const p of toPay) tp.append(buildProposalRow(p, partner.get(p.receiver), p.receiver, 'topay'))
}

/**
 * Eén verzoek-rij: partner-avatar (→ profiel) · vakje met bedrag+omschrijving · actie-iconen.
 * `kind` = 'mine' (mijn verzoek, alleen annuleren) of 'topay' (betalen + annuleren).
 */
function buildProposalRow(p, prof, partnerId, kind) {
  const mine = kind === 'mine'
  const row = document.createElement('div')
  row.className = mine ? 'my-request-row' : 'request-row'
  const profHref = partnerId === me ? '#/profile' : `#/profile/${partnerId}`
  const desc = (p.description || '').slice(0, mine ? 25 : 20)
  row.innerHTML =
    `<div class="request-column1"><a href="${profHref}"><img class="mainusericon" src="${avatarFor(prof)}" /></a></div>` +
    `<div class="${mine ? 'my-request-column2' : 'request-column2'}">` +
      `<div class="select-button-static"><div class="amount-line">${formatCoins(p.amount)} ᕫ</div><div class="desc-line">${desc}</div></div>` +
    `</div>` +
    (mine
      ? `<div class="my-request-column3"><img class="action-icon" src="img/Cancel.png" alt="annuleren" data-act="cancel" /></div>`
      : `<div class="request-column3"><div class="action-form-dual">` +
          `<img class="action-icon" src="img/Okay.png" alt="betalen" data-act="pay" />` +
          `<img class="action-icon" src="img/Cancel.png" alt="annuleren" data-act="cancel" />` +
        `</div></div>`)
  row.querySelector('[data-act="cancel"]')?.addEventListener('click', () => cancelProposal(p.pid))
  row.querySelector('[data-act="pay"]')?.addEventListener('click', () => confirmPay(p))
  // Het vakje zelf: betalen (te betalen) — bij eigen verzoek niet-klikbaar.
  if (!mine) row.querySelector('.select-button-static')?.addEventListener('click', () => confirmPay(p))
  return row
}

/** Een openstaand verzoek annuleren/intrekken (verwijdert de proposal). */
async function cancelProposal(pid) {
  log(`Verzoek ${pid} annuleren…`)
  try { if (await stores.proposals.get(pid)) await stores.proposals.del(pid) } catch (e) { log('annuleren-fout: ' + e.message) }
  await render()
}

// ============================ TRANSACTIES ============================
let txUserId = null, txYear = null, txMonth = null, txSelectedTid = 0

/** Alle transacties van een gebruiker, oplopend op tijd (tie-break tid). */
async function userTransactions(uid) {
  const txs = (await stores.transactions.all()).map((e) => e.value)
    .filter((t) => t.giver === uid || t.receiver === uid)
  txs.sort((a, b) => a.time_stamp < b.time_stamp ? -1 : a.time_stamp > b.time_stamp ? 1 : (a.tid - b.tid))
  return txs
}

/**
 * Saldo-staat vlak vóór een transactie — 1-op-1 uit getPreviousTransactionState
 * (functions.inc.php): tijdstempels op het hele uur, decay per gat, basisinkomen
 * per uur. `allUserTxs` = alle tx van de gebruiker (op tijd gesorteerd).
 */
function previousTransactionState(allUserTxs, userId, targetTs, joined) {
  const r = DECAY_RATE
  const topOfHour = (d) => { const x = new Date(d); x.setUTCMinutes(0, 0, 0); return x }
  let currentBalance = 1000.0
  let lastProcessed = topOfHour(parseSqlDate(joined))
  const target = parseSqlDate(targetTs)

  for (const row of allUserTxs) {
    const rowTime = parseSqlDate(row.time_stamp)
    if (rowTime.getTime() >= target.getTime()) continue // alleen tx vóór de doel-tx
    const thisTime = topOfHour(rowTime)
    const hours = Math.max(0, Math.floor((thisTime.getTime() - lastProcessed.getTime()) / 3_600_000))
    if (hours > 0) {
      currentBalance = currentBalance * Math.pow(r, hours)
      currentBalance += (r * (1 - Math.pow(r, hours))) / (1 - r)
    }
    if (row.giver === userId) currentBalance -= Number(row.amount)
    else currentBalance += Number(row.amount)
    lastProcessed = thisTime
  }

  const finalTarget = topOfHour(target)
  const finalHours = Math.max(0, Math.floor((finalTarget.getTime() - lastProcessed.getTime()) / 3_600_000))
  const reductionFactor = Math.pow(r, finalHours)
  const reductionAmount = currentBalance * (1 - reductionFactor)
  const income = finalHours > 0 ? (r * (1 - Math.pow(r, finalHours))) / (1 - r) : 0
  const availableBalance = currentBalance * reductionFactor + income
  return { previousBalance: currentBalance, hours: finalHours, reductionFactor, reductionAmount: -reductionAmount, income, availableBalance }
}

// ============================ PERSOON ZOEKEN (request.php) ============================
// Zoekt op naam óf rekeningnummer, precies zoals het origineel:
//  - puur cijfers  → nummer. Onder 100 exact, vanaf 100 "begint met" (005 vindt alleen 5,
//    100 vindt 100, 1001, 1002…). Dat is bewust: de eerste 99 nummers zijn schaars.
//  - anders        → naam, bevat-zoekopdracht, hoofdletterongevoelig.
// Zes per pagina; de zoekknop is dood onder de 3 tekens.
const PAGE_SIZE = 6
let searchQuery = ''
let searchStart = 0 // 0-gebaseerd, in tegenstelling tot het origineel (dat telde vanaf 1)
let searchDone = false

/** Alle andere gebruikers, ontsleuteld, gesorteerd zoals het origineel. */
async function searchMatches() {
  const docs = (await stores.users.all()).map((e) => e.value).filter((u) => u.usersId !== me)
  // 05: contacten (persons met wie je al proposals/verzoeken hebt) eerst, dan de rest.
  const proposals = (await stores.proposals.all()).map((e) => e.value)
  const contactIds = new Set()
  for (const p of proposals) {
    if (p.receiver === me) contactIds.add(p.giver)
    if (p.giver === me) contactIds.add(p.receiver)
  }
  const byContact = (a, b) => {
    const ac = contactIds.has(a.usersId) ? 0 : 1
    const bc = contactIds.has(b.usersId) ? 0 : 1
    return ac - bc
  }
  const profiles = await Promise.all(docs.map((d) => safeProfile(d)))
  const q = searchQuery.trim()
  const numeric = q !== '' && /^\d+$/.test(q)

  let hits
  if (!q) {
    hits = profiles.sort((a, b) => byContact(a, b) || (a.usersId - b.usersId))
  } else if (numeric) {
    const n = Number(q)
    hits = n < 100
      ? profiles.filter((p) => p.usersId === n)
      : profiles.filter((p) => String(p.usersId).startsWith(q))
    hits.sort((a, b) => byContact(a, b) || (a.usersId - b.usersId))
  } else {
    const needle = q.toLowerCase()
    hits = profiles.filter((p) => (p.usersName || '').toLowerCase().includes(needle))
    hits.sort((a, b) => byContact(a, b) || (a.usersName || '').localeCompare(b.usersName || ''))
  }
  return hits
}

async function renderSearch() {
  const hits = await searchMatches()
  const total = hits.length
  if (searchStart >= total) searchStart = 0
  const page = hits.slice(searchStart, searchStart + PAGE_SIZE)

  const box = $('searchResults'); box.innerHTML = ''
  for (const p of page) {
    const row = document.createElement('div')
    row.className = 'button8-row'
    row.innerHTML = `
      <div class="button8-column1">
        <button type="button" class="avatar-button"><img class="mainusericon" alt="" /></button>
      </div>
      <div class="button8-column2"></div>
      <div class="button8-column3">
        <button type="button" class="select-button">
          <span>${formatDisplayNum(p.usersId)}</span><span></span>
        </button>
      </div>`
    row.querySelector('img').src = avatarFor(p)
    row.querySelector('.select-button span:last-child').textContent = p.usersName || `#${p.usersId}`
    // Foto → persoonsdetail; brede knop → direct het verzoek (net als in het origineel).
    row.querySelector('.avatar-button').onclick = () => { location.hash = `#/profile/${p.usersId}` }
    row.querySelector('.select-button').onclick = () => { location.hash = `#/request/${p.usersId}` }
    box.append(row)
    const line = document.createElement('div'); line.className = 'small_line'; box.append(line)
  }

  renderSearchNav(total)
  $('searchError').classList.toggle('hidden', !(total === 0 && searchDone))
}

/** Start/Vorige boven, Einde(totaal)/Volgende onder — alleen bij meer dan één pagina. */
function renderSearchNav(total) {
  const top = $('searchNavTop'); const bottom = $('searchNavBottom')
  top.innerHTML = ''; bottom.innerHTML = ''
  if (total <= PAGE_SIZE) return

  const atStart = searchStart <= 0
  const atEnd = searchStart + PAGE_SIZE >= total
  const btn = (label, disabled, onclick) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = disabled ? 'disabled-button' : 'login-button'
    b.disabled = disabled
    b.textContent = label
    if (!disabled) b.onclick = onclick
    return b
  }
  const row = (cls, left, right) => {
    const d = document.createElement('div'); d.className = `${cls}-row`
    const c1 = document.createElement('div'); c1.className = `${cls}-column1`; c1.append(left)
    const c2 = document.createElement('div'); c2.className = `${cls}-column2`
    const c3 = document.createElement('div'); c3.className = `${cls}-column3`; c3.append(right)
    d.append(c1, c2, c3); return d
  }
  const go = (start) => { searchStart = Math.max(0, start); render().catch(() => {}) }

  top.append(row('button4',
    btn(t('REQ_START'), atStart, () => go(0)),
    btn(t('REQ_PREV'), atStart, () => go(searchStart - PAGE_SIZE))))
  bottom.append(row('button6',
    btn(`${t('REQ_END')} (${total.toLocaleString('en-US').replace(/,/g, ' ')})`, atEnd, () => go(total - PAGE_SIZE)),
    btn(t('REQ_NEXT'), atEnd, () => go(searchStart + PAGE_SIZE))))
}

/** Zoekknop is pas actief vanaf 3 tekens (origineel: validateSearch()). */
function updateSearchBtn() {
  const clean = ($('searchInput').value || '').replace(/\s/g, '')
  $('searchBtn').disabled = clean.length < 3 && clean.length > 0
  $('searchBtn').classList.toggle('is-disabled', clean.length > 0 && clean.length < 3)
}

// ============================ VERZOEK (receiver.php) ============================
// Eén gekozen gever. Toont hun beschikbare saldo, kleurt het bedrag rood zodra het
// daarboven komt, en respecteert hún firewall: sta ik op hun blokkeerlijst (of, bij
// witte-lijst-modus, niet op hun witte lijst), dan geen formulier maar uitleg.
let rcvGiver = 0
let rcvAvail = 0 // saldo van de gever, gezet bij het openen van het scherm (niet per toetsaanslag)

/** Beschikbaar saldo van een willekeurige gebruiker, met dezelfde ledger-kern als de header. */
async function availableFor(userId) {
  const doc = (await stores.users.get(userId))?.value
  const usersOld = (await stores.usersOld.all()).map((e) => e.value)
  const txs = (await stores.transactions.all()).map((e) => e.value)
  return availableCoins({ joined: joinedDate(doc, usersOld), transactions: txs, userId, asOf: new Date() })
}

/** Mag ik deze persoon een verzoek sturen? Hun lijsten, niet die van mij. */
async function mayRequestFrom(giverDoc, giverId) {
  if (Number(giverDoc?.useWhitelist) === 1) {
    const allows = await getList({ stores, ownerId: giverId, listType: WHITELIST })
    return allows.includes(me)
  }
  const blocks = await getList({ stores, ownerId: giverId, listType: BLACKLIST })
  return !blocks.includes(me)
}

async function renderRequest({ id } = {}) {
  const giver = Number(id)
  if (!giver || giver === me) { location.hash = '#/search'; return }
  if (giver !== rcvGiver) { rcvGiver = giver; $('rcvAmount').value = ''; $('rcvDesc').value = ''; $('rcvInfo').textContent = '' }

  const doc = (await stores.users.get(giver))?.value
  if (!doc) { $('rcvName').textContent = t('HD_ERR_404'); return }
  const prof = await safeProfile(doc)
  const avail = await availableFor(giver)
  rcvAvail = avail

  $('rcvNum').textContent = formatDisplayNum(giver)
  $('rcvImg').src = avatarFor(prof)
  $('rcvName').textContent = prof.usersName || `#${giver}`
  $('rcvAvail').textContent = `${t('RCV_AVAIL')}: ${formatCoins(avail)} ᕫ`
  $('rcvDetailLink').href = `#/profile/${giver}`
  $('rcvDetailLink2').href = `#/profile/${giver}`

  const allowed = await mayRequestFrom(doc, giver)
  $('rcvForm').classList.toggle('hidden', !allowed)
  $('rcvBlocked').classList.toggle('hidden', allowed)
  $('rcvSendBtn').classList.toggle('hidden', !allowed)
  if (!allowed) {
    $('rcvBlockedText').innerHTML = ''
    for (const k of ['RCV_BLOCKED_1', 'RCV_BLOCKED_2', 'RCV_BLOCKED_3']) {
      $('rcvBlockedText').append(document.createTextNode(t(k)), document.createElement('br'))
    }
  }
  checkAmount(avail)
}

/** Duizendtallen met spaties; rood zodra het bedrag boven hun saldo uitkomt. */
function checkAmount(avail) {
  const el = $('rcvAmount')
  const raw = (el.value || '').replace(/[^\d.]/g, '')
  const [int, ...rest] = raw.split('.')
  el.value = rest.length
    ? `${int.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}.${rest.join('')}`
    : int.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
  const amount = Number((el.value || '').replace(/\s/g, '')) || 0
  el.classList.toggle('amount-error', avail != null && amount > avail)
  return amount
}

async function sendRequest() {
  const btn = $('rcvSendBtn'); btn.disabled = true
  const info = (m) => { $('rcvInfo').textContent = m }
  try {
    const giver = rcvGiver
    const amount = Number(($('rcvAmount').value || '').replace(/\s/g, '')) || 0
    const description = ($('rcvDesc').value || '').trim()
    // Dezelfde controles als receiver.inc.php.
    if (description.length < 3) { $('rcvInfo').className = 'error'; info(t('RCV_ERR_DESC')); return }
    // Bedrag nul of leeg: geen melding, alleen het veld markeren — er valt niets uit te leggen.
    if (amount <= 0) { $('rcvAmount').classList.add('amount-error'); $('rcvAmount').focus(); return }
    // 06: altijd kunnen vragen — geen saldo-limiet bij versturen. Proposal blijft open tot
    // de gever voldoende saldo heeft (confirmPay weigert dan, proposal blijft staan).

    const giverDoc = (await stores.users.get(giver))?.value
    const receiverDoc = (await stores.users.get(me))?.value
    const p = await createProposal({ stores, giver, receiver: me, amount, description, giverDoc, receiverDoc, asOf: new Date() })
    log(`Verzoek verstuurd (pid ${p.pid}). Wacht op bevestiging door #${giver}.`)
    const prof = await safeProfile(giverDoc)
    $('rcvInfo').className = 'success'
    info(`${t('RCV_SUCCESS')} ${prof.usersName || '#' + giver}`)
    $('rcvAmount').value = ''; $('rcvDesc').value = ''
    await render()
  } catch (e) {
    $('rcvInfo').className = 'error'
    info('FOUT: ' + e.message)
  } finally {
    btn.disabled = false
  }
}

async function renderTransactions({ id } = {}) {
  const uid = id != null ? Number(id) : me
  if (uid !== txUserId) { txUserId = uid; txYear = null; txMonth = null; txSelectedTid = 0 }

  const users = (await stores.users.all()).map((e) => e.value)
  const usersOld = (await stores.usersOld.all()).map((e) => e.value)
  const all = await userTransactions(uid)

  // Naam van de getoonde gebruiker (eigen profiel is al ontsleuteld).
  let viewName = `#${uid}`
  if (uid === me) viewName = myProfile.usersName
  else { const d = users.find((u) => u.usersId === uid); if (d) { try { viewName = (await decryptUserProfile(d, communityKey)).usersName } catch {} } }
  $('txViewName').textContent = viewName

  // Standaard: meest recente maand met activiteit (anders nu).
  if (txYear == null) {
    const last = all[all.length - 1]
    const d = last ? parseSqlDate(last.time_stamp) : new Date()
    txYear = d.getUTCFullYear(); txMonth = d.getUTCMonth() + 1
  }

  // Jaar-select: van het vroegste activiteitsjaar (min. 2024) t/m dit jaar.
  const nowY = new Date().getUTCFullYear()
  const firstY = all.length ? parseSqlDate(all[0].time_stamp).getUTCFullYear() : nowY
  const yearFrom = Math.min(2024, firstY)
  fillNav('navYear', range(yearFrom, nowY).map((y) => [y, String(y)]), txYear)
  fillNav('navMonth', monthsLong().map((m, i) => [i + 1, m]), txMonth)

  // Maand-transacties.
  const monthTxs = all.filter((t) => { const d = parseSqlDate(t.time_stamp); return d.getUTCFullYear() === txYear && d.getUTCMonth() + 1 === txMonth })
  // Standaard de NIEUWSTE transactie van de maand selecteren (monthTxs is op tijd oplopend),
  // zodat het rekenpaneel bij binnenkomst de actuele staat toont i.p.v. de basis (1000/0 uur)
  // van de allereerste transactie.
  if (!monthTxs.some((t) => t.tid === txSelectedTid)) txSelectedTid = monthTxs.length ? monthTxs[monthTxs.length - 1].tid : 0

  // Prev/next maand met activiteit.
  const startOfView = Date.UTC(txYear, txMonth - 1, 1)
  const endOfView = Date.UTC(txYear, txMonth, 1) // exclusief
  const prev = [...all].reverse().find((t) => parseSqlDate(t.time_stamp).getTime() < startOfView)
  const next = all.find((t) => parseSqlDate(t.time_stamp).getTime() >= endOfView)
  setNavBtn('navPrev', prev, () => { const d = parseSqlDate(prev.time_stamp); txYear = d.getUTCFullYear(); txMonth = d.getUTCMonth() + 1; txSelectedTid = 0; renderTransactions({ id: uid }) })
  setNavBtn('navNext', next, () => { const d = parseSqlDate(next.time_stamp); txYear = d.getUTCFullYear(); txMonth = d.getUTCMonth() + 1; txSelectedTid = 0; renderTransactions({ id: uid }) })

  // Lijst.
  const joined = joinedDate(users.find((u) => u.usersId === uid) ?? { usersId: uid, start: all[0]?.time_stamp }, usersOld)
  const listEl = $('txList'); listEl.innerHTML = ''
  $('txNone').style.display = monthTxs.length ? 'none' : 'block'
  listEl.style.display = monthTxs.length ? 'block' : 'none'
  for (const t of monthTxs) {
    const isGiver = t.giver === uid
    const state = previousTransactionState(all, uid, t.time_stamp, joined)
    const balanceAfter = state.availableBalance + (isGiver ? -t.amount : t.amount)
    const row = document.createElement('div')
    row.className = t.tid === txSelectedTid ? 'list-row-selected' : 'list-row'
    const color = isGiver ? 'var(--error)' : '#00BFFF'
    const sign = isGiver ? '-' : '+'
    row.innerHTML =
      `<span class="list-date">${fmtRowDate(t.time_stamp)}</span>` +
      `<span class="list-amt" style="color:${color}">${sign}${formatCoins(t.amount)} ᕫ</span>` +
      `<span class="list-bal">${formatCoins(balanceAfter)} ᕫ</span>`
    row.onclick = () => { txSelectedTid = t.tid; renderTransactions({ id: uid }) }
    listEl.append(row)
  }

  // Berekening-paneel voor de geselecteerde rij.
  renderCalc(all, uid, monthTxs, joined, users)
}

/** Berekening-paneel (decay/income) onder de lijst — uit transactions.php. */
function renderCalc(all, uid, monthTxs, joined, users) {
  const box = $('txCalc'); box.innerHTML = ''
  // LET OP: niet `t` gebruiken voor de transactie — dat overschaduwt de i18n-functie t().
  const tx = monthTxs.find((x) => x.tid === txSelectedTid)
  if (!tx) return
  const isGiver = tx.giver === uid
  const st = previousTransactionState(all, uid, tx.time_stamp, joined)
  const newBalance = st.availableBalance + (isGiver ? -tx.amount : tx.amount)

  // BRUG NAAR NU: 'Nieuw saldo' is het saldo direct ná de transactie (historisch).
  // De kop toont het LIVE saldo (availableCoins, nu) — dat groeit sindsdien door met
  // basisinkomen/decay, dus die twee wijken af. Voor de NIEUWSTE transactie van de
  // gebruiker tonen we daarom een afsluitregel 'Huidig saldo' = exact de kopwaarde
  // (zelfde functie + data als renderHeader → gegarandeerd gelijk), met de aangroei
  // sinds die transactie ertussen. Zo sluit het overzicht aan op het werkelijke saldo.
  const isLatest = all.length > 0 && tx.tid === all[all.length - 1].tid
  let bridge = ''
  if (isLatest) {
    const liveBal = availableCoins({ joined, transactions: all, userId: uid, asOf: new Date() })
    const elapsed = Math.floor(Math.abs(Date.now() - parseSqlDate(tx.time_stamp).getTime()) / 3_600_000)
    const delta = liveBal - newBalance
    const dColor = delta >= 0 ? '#00BFFF' : 'var(--error)'
    const dSign = delta >= 0 ? '+' : '-'
    bridge =
      calcRow(`Sinds laatste transactie (${elapsed} u)`, `<span style="color:${dColor}">${dSign}${formatCoins(Math.abs(delta))} ᕫ</span>`) +
      `<div class="full-screen-line"></div>` +
      calcRow('<strong>Huidig saldo</strong>', `<strong>${formatCoins(liveBal)} ᕫ</strong>`) +
      `<div class="full-screen-line"></div>`
  }

  const partnerId = isGiver ? tx.receiver : tx.giver
  const partnerDoc = users.find((u) => u.usersId === partnerId)
  const color = isGiver ? 'var(--error)' : '#00BFFF'
  const sign = isGiver ? '-' : '+'
  const desc = (tx.description || '').slice(0, 25)

  box.innerHTML =
    `<div class="full_line"></div>` +
    calcRow(t('TR_HOURS'), String(st.hours)) +
    calcRow(t('TR_REDUCTION_MATH') + ': 0.99995^' + st.hours, st.reductionFactor.toFixed(8)) +
    `<div class="full-screen-line"></div>` +
    calcRow(`<strong>${t('TR_PREV_BAL')}</strong>`, `<strong>${formatCoins(st.previousBalance)} ᕫ</strong>`) +
    calcRow(t('TR_REDUCTION'), `<span style="color:var(--error)">-${formatCoins(Math.abs(st.reductionAmount))} ᕫ</span>`) +
    calcRow(t('TR_INCOME'), `<span style="color:#00BFFF">+${formatCoins(st.income)} ᕫ</span>`) +
    `<div class="full-screen-line"></div>` +
    calcRow(`<strong>${t('TR_AVAIL_BAL')}</strong>`, `<strong>${formatCoins(st.availableBalance)} ᕫ</strong>`) +
    `<a class="transaction-detail-link" id="calcDetailLink">` +
      `<div class="calc-row transaction-hover-row" style="align-items:center; position:relative; display:flex;">` +
        `<span class="calc-title" style="display:flex; align-items:center; flex:1; min-width:0;">` +
          `<img src="${avatarFor(partnerDoc ? { usersId: partnerId } : null)}" class="transactionicon2" />` +
          `<span class="expanded-desc">${desc}</span>` +
        `</span>` +
        `<span class="calc-val" style="color:${color}; flex-shrink:0; text-align:right;">${sign}${formatCoins(tx.amount)} ᕫ</span>` +
      `</div>` +
    `</a>` +
    `<div class="full-screen-line"></div>` +
    calcRow('<strong>Nieuw saldo</strong>', `<strong>${formatCoins(newBalance)} ᕫ</strong>`) +
    `<div class="full-screen-line"></div>` +
    bridge
  const link = $('calcDetailLink'); if (link) link.href = `#/tx/${tx.tid}`
}

const calcRow = (title, val) => `<div class="calc-row"><span class="calc-title">${title}</span><span class="calc-val">${val}</span></div>`
const range = (a, b) => { const out = []; for (let i = a; i <= b; i++) out.push(i); return out }
function fillNav(id, pairs, selected) {
  const sel = $(id); if (!sel) return
  const want = pairs.map(([v, label]) => `${v}=${label}`).join(',') // label mee → herbouwt bij taalwissel
  if (sel.dataset.keys !== want) {
    sel.innerHTML = ''
    for (const [v, label] of pairs) { const o = document.createElement('option'); o.value = v; o.textContent = label; sel.append(o) }
    sel.dataset.keys = want
  }
  sel.value = String(selected)
}
function setNavBtn(id, enabled, onclick) {
  const b = $(id); if (!b) return
  b.classList.toggle('nav-disabled', !enabled)
  b.onclick = enabled ? onclick : null
}

// ============================ TRANSACTIE-DETAIL ============================
async function renderTxDetail({ tid } = {}) {
  const id = Number(tid)
  const txs = (await stores.transactions.all()).map((e) => e.value)
  const t = txs.find((x) => x.tid === id)
  if (!t) { $('txdDesc').value = 'Transactie niet gevonden.'; return }

  const giverDoc = (await stores.users.get(t.giver))?.value
  const receiverDoc = (await stores.users.get(t.receiver))?.value
  const giverP = giverDoc ? await safeProfile(giverDoc) : { usersName: `#${t.giver}`, usersId: t.giver }
  const receiverP = receiverDoc ? await safeProfile(receiverDoc) : { usersName: `#${t.receiver}`, usersId: t.receiver }

  $('txdDate').value = fmtDetailDate(t.time_stamp)
  $('txdDesc').value = t.description || ''
  $('txdAmount').value = `${formatCoins(t.amount)} ᕫ`
  $('txdGiverName').textContent = giverP.usersName
  $('txdReceiverName').textContent = receiverP.usersName
  $('txdGiverImg').src = avatarFor({ usersId: t.giver, usersName: giverP.usersName, image: giverP.image })
  $('txdReceiverImg').src = avatarFor({ usersId: t.receiver, usersName: receiverP.usersName, image: receiverP.image })
  $('txdGiverLink').href = t.giver === me ? '#/profile' : `#/profile/${t.giver}`
  $('txdReceiverLink').href = t.receiver === me ? '#/profile' : `#/profile/${t.receiver}`
  // Terug → de transactielijst van de eigen/peer-keten.
  $('txdBack').href = '#/transactions'
}

async function safeProfile(doc) {
  try { return await decryptUserProfile(doc, communityKey) } catch { return { usersName: `#${doc.usersId}`, usersId: doc.usersId } }
}

// ============================ PROFIEL (eigen + peer) ============================
let profileEditing = false
// Profielhistorie-weergave (gat C): de doorbladerbare versies van het getoonde profiel.
let revVersions = []
let revIdx = 0
let revIsMe = false
let revUid = null

async function renderProfile({ id } = {}) {
  if (profileEditing) return // niet herrenderen tijdens bewerken (zou velden overschrijven)
  const uid = id != null ? Number(id) : me
  const isMe = uid === me
  // Header (punt 02): eigen profiel = direct-edit (Opslaan/JIJ/Terug); peer = alleen-lezen.
  $('profHeaderSave').style.display = isMe ? '' : 'none'
  if (isMe) { $('profHeaderTitle').textContent = t('APP_YOU'); enterProfileEdit(); return }
  $('profHeaderTitle').textContent = '' // peer-naam wordt hieronder ingevuld
  $('profEditActions').style.display = 'none'
  $('profView').classList.remove('hidden')
  $('profEdit').classList.add('hidden')
  let p
  const doc = (await stores.users.get(uid))?.value
  if (!doc) { $('profName').textContent = 'Onbekende gebruiker'; $('profHeaderTitle').textContent = 'Onbekende gebruiker'; $('profFields').innerHTML = ''; $('profRevNav').style.display = 'none'; return }
  p = await safeProfile(doc)
  $('profHeaderTitle').textContent = p.usersName || `#${uid}`

  const txs = (await stores.transactions.all()).map((e) => e.value)
  const usersOld = (await stores.usersOld.all()).map((e) => e.value)
  const myDoc = (await stores.users.get(uid))?.value
  const joined = joinedDate(myDoc ?? { usersId: uid, start: txs[0]?.time_stamp }, usersOld)
  const bal = availableCoins({ joined, transactions: txs, userId: uid, asOf: new Date() })

  $('profBalance').textContent = `${formatCoins(bal)} ᕫ`
  $('profBalanceLink').href = isMe ? '#/transactions' : `#/transactions/${uid}` // saldo → keten (humandetails)

  // Profielhistorie (gat C): huidige versie + de gearchiveerde versies uit users_old
  // (nieuwste historische eerst), doorbladerbaar met Vorige/Volgende. Alleen échte
  // snapshots (met enc); de slank-gemigreerde join-only rijen overslaan.
  const histSnaps = usersOld
    .filter((o) => o.uid_old === uid && o.enc)
    .sort((a, b) => (a.start_old < b.start_old ? 1 : a.start_old > b.start_old ? -1 : 0))
  const hist = []
  for (const s of histSnaps) hist.push({ profile: await safeProfile(s), start_old: s.start_old, end_old: s.end_old })
  const today = new Date().toISOString().slice(0, 10)
  const curStart = hist.length ? hist[0].end_old : joined
  revUid = uid
  revIsMe = isMe
  revVersions = [
    { profile: p, period: `${formatDateNL(curStart)} – ${formatDateNL(today)}` },
    ...hist.map((h) => ({ profile: h.profile, period: `${formatDateNL(h.start_old)} – ${formatDateNL(h.end_old)}` })),
  ]
  revIdx = 0
  $('profRevNav').style.display = revVersions.length > 1 ? 'flex' : 'none'
  renderProfileVersion()

  // Statistieken-blok (alleen op andermans profiel) — uit 1coinh humandetails.php.
  const statsBox = $('profStatsBox')
  if (!isMe) {
    statsBox.style.display = 'block'
    $('profStats').innerHTML = renderProfileStats(txs, uid, me, joined)
  } else {
    statsBox.style.display = 'none'
  }

  await renderListControls(uid, isMe) // blok-/whitelijst-knoppen
}

/**
 * Toon de geselecteerde profielversie (huidig = index 0, of een gearchiveerde uit
 * users_old) in de profielweergave: avatar, naam en velden wisselen mee; saldo/statistieken
 * blijven (die horen bij de persoon, niet bij de versie). De caption toont positie +
 * geldigheidsperiode; bewerken kan alleen op de EIGEN, huidige versie.
 */
function renderProfileVersion() {
  const v = revVersions[revIdx]
  if (!v) return
  const p = v.profile
  $('profImg').src = avatarFor({ ...p, usersId: revUid })
  $('profName').textContent = p.usersName || `#${revUid}`
  const hair = hairLabels()[p.hair] ?? (p.hair ?? '—')
  const left = eyeLabels()[p.leftEye] ?? (p.leftEye ?? '—')
  const right = eyeLabels()[p.rightEye] ?? (p.rightEye ?? '—')
  let html =
    calcRow(t('SU_HT'), p.height || '—') +
    calcRow(t('SU_GN'), genderLabels()[p.gender] ?? '—') +
    calcRow(t('SU_HR'), hair) +
    calcRow(t('SU_LE'), left) +
    calcRow(t('SU_RE'), right) +
    calcRow(t('SU_BD'), formatDateNL(p.birthday)) +
    calcRow(t('SU_SF'), p.specialFeatures || '—')
  if (revIsMe) html += calcRow(t('SU_EM'), p.usersEmail || '—') // alleen op eigen profiel
  $('profFields').innerHTML = html

  const histTag = revIdx === 0 ? '' : `${t('BTN_HISTORY')} · `
  $('profRevLabel').textContent = `${histTag}${revIdx + 1}/${revVersions.length} · ${v.period}`
  $('profRevPrev').disabled = revIdx >= revVersions.length - 1 // Vorige = ouder
  $('profRevNext').disabled = revIdx <= 0                      // Volgende = nieuwer
  $('profEditActions').style.display = (revIsMe && revIdx === 0) ? 'flex' : 'none'
}

/**
 * Statistieken + Vertrouwen-score voor een peer-profiel, 1-op-1 uit 1coinh
 * `humandetails.php` (trust-log-curve + tellingen). `h` = bekeken profiel, `m` = ik.
 * De score is relatief t.o.v. de kijker (eigen transacties met deze persoon wegen het zwaarst).
 */
function renderProfileStats(txs, h, m, joinedStr) {
  const cnt = (f) => txs.reduce((n, x) => n + (f(x) ? 1 : 0), 0)
  const uniq = (pick, f) => new Set(txs.filter(f).map(pick)).size
  const hGiver = cnt((x) => x.giver === h)
  const hGiverU = uniq((x) => x.receiver, (x) => x.giver === h)
  const hReceiver = cnt((x) => x.receiver === h)
  const hReceiverU = uniq((x) => x.giver, (x) => x.receiver === h)
  const mGiver = cnt((x) => x.giver === m && x.receiver === h) // ik → profiel (van jou)
  const mReceiver = cnt((x) => x.receiver === m && x.giver === h) // profiel → ik (aan jou betaald)
  const pOthers = hGiver - mReceiver // profiel betaalde anderen
  const rOthers = hReceiver - mGiver // profiel ontving van anderen

  const joinedDt = joinedStr ? parseSqlDate(joinedStr) : new Date()
  const hours = Math.max(0, (Date.now() - joinedDt.getTime()) / 3600000)
  const days = hours / 24
  const vdays = days < 10 ? days.toFixed(1) : Math.round(days).toString()

  const curve = (v) => (v <= 0 ? 0 : 7.427 * Math.log(v + 0.008) + 35.85)
  const trust = curve(mGiver) * 0.37 + curve(mReceiver) * 0.16 + curve(hReceiver) * 0.12 +
                curve(hGiver) * 0.04 + curve(hReceiverU) * 0.22 + curve(hGiverU) * 0.02 + curve(hours) * 0.07
  const finalTrust = Math.max(0.1, Math.min(99.9, Math.round(trust)))

  return calcRow(`${t('ST_PART')} ${vdays} ${t('ST_DAYS')}`, `${t('ST_TRUST')} ${finalTrust}%`) +
         calcRow(`${t('ST_PAID_YOU')}: ${mReceiver}`, `${t('ST_FROM_YOU')}: ${mGiver}`) +
         calcRow(`${t('ST_PAID_OTHERS')} ${pOthers}`, `${t('ST_RECEIVED')}: ${rOthers}`) +
         calcRow(`${t('ST_UNI_PAID')}: ${hGiverU}`, `${t('ST_UNI_REC')}: ${hReceiverU}`)
}

// ============================ BLOK-/WHITELIJST ============================
/** Toon de juiste knoppen: peer → blokkeren/toestaan; eigen → privacy-modus + beheerlijst. */
async function renderListControls(uid, isMe) {
  const wl = Number(myProfile.useWhitelist) === 1
  const blocks = new Set(await getList({ stores, ownerId: me, listType: BLACKLIST }))
  const allows = new Set(await getList({ stores, ownerId: me, listType: WHITELIST }))

  if (isMe) {
    $('profPeerActions').style.display = 'none'
    $('privacyBox').style.display = 'block'
    await renderPrivacy(wl, blocks, allows)
    return
  }

  $('privacyBox').style.display = 'none'
  $('profPeerActions').style.display = 'flex'
  const btn = $('profBlockBtn')
  if (wl) {
    const allowed = allows.has(uid)
    btn.textContent = allowed ? t('APP_WL_REMOVE') : t('APP_WL_ALLOW')
    btn.onclick = () => (allowed ? removeAllow(uid) : allowUser(uid)).catch((e) => log('FOUT: ' + e.message))
  } else {
    const blocked = blocks.has(uid)
    btn.textContent = blocked ? t('HD_UNBLOCK') : t('HD_BLOCK')
    btn.onclick = () => (blocked ? unblockUser(uid) : blockUser(uid)).catch((e) => log('FOUT: ' + e.message))
  }
}

/** Eigen profiel: modus-uitleg, schakelknop, toevoegen, beheerlijst en e-mailvoorkeuren. */
async function renderPrivacy(wl, blocks, allows) {
  $('privacyModeText').textContent = wl ? t('APP_PRIV_WL_MODE') : t('APP_PRIV_BL_MODE')
  const toggle = $('privacyToggleBtn')
  toggle.textContent = wl ? t('APP_TO_BL') : t('APP_TO_WL')
  toggle.onclick = () => setPrivacyMode(wl ? 0 : 1).catch((e) => log('FOUT: ' + e.message))

  const active = wl ? allows : blocks
  const users = (await stores.users.all()).map((e) => e.value)
  const nameOf = (id) => users.find((u) => u.usersId === id)?.usersName || `#${id}`

  // Toevoegen: kandidaten = anderen die nog niet op de actieve lijst staan.
  const sel = $('listAddSelect')
  const candidates = users.filter((u) => u.usersId !== me && !active.has(u.usersId))
  const key = candidates.map((u) => u.usersId).join(',')
  if (sel.dataset.keys !== key) {
    sel.innerHTML = ''
    for (const u of candidates) { const o = document.createElement('option'); o.value = u.usersId; o.textContent = `${u.usersName || '#' + u.usersId} (#${u.usersId})`; sel.append(o) }
    sel.dataset.keys = key
  }
  $('listAddLabel').firstChild.textContent = wl ? t('APP_ALLOW') : t('APP_BLOCK')
  $('listAddBtn').textContent = wl ? t('APP_ADD_WL') : t('HD_BLOCK')
  $('listAddBtn').onclick = () => {
    const id = Number(sel.value); if (!id) return
    ;(wl ? allowUser(id) : blockUser(id)).catch((e) => log('FOUT: ' + e.message))
  }
  $('listAddLabel').style.display = candidates.length ? '' : 'none'
  $('listAddBtn').style.display = candidates.length ? '' : 'none'

  // Beheerlijst van de actieve lijst.
  const ids = [...active]
  const box = $('listManage'); box.innerHTML = ''
  if (!ids.length) box.innerHTML = `<p class="muted">${wl ? t('APP_NONE_ALLOWED') : t('APP_NONE_BLOCKED')}</p>`
  for (const id of ids) {
    const row = document.createElement('div'); row.className = 'calc-row'
    row.innerHTML = `<span class="calc-title"><a href="#/profile/${id}">${nameOf(id)} (#${id})</a></span>`
    const b = document.createElement('button'); b.className = 'btn-secondary'
    b.textContent = wl ? t('BW_BTN_DELETE') : t('HD_UNBLOCK')
    b.onclick = () => (wl ? removeAllow(id) : unblockUser(id)).catch((e) => log('FOUT: ' + e.message))
    row.append(b); box.append(row)
  }

  // E-mailvoorkeuren (niet overschrijven terwijl de gebruiker net klikt).
  const pay = $('prefPaymentEmails'); const news = $('prefNewsletter')
  if (document.activeElement !== pay) pay.checked = Number(myProfile.paymentEmails) === 1
  if (document.activeElement !== news) news.checked = Number(myProfile.newsletter) === 1
  pay.onchange = () => setPref('paymentEmails', pay.checked ? 1 : 0).catch((e) => log('FOUT: ' + e.message))
  news.onchange = () => setPref('newsletter', news.checked ? 1 : 0).catch((e) => log('FOUT: ' + e.message))
}

/** Een voorkeur-vlag op het user-doc bijwerken (newsletter / paymentEmails). */
async function setPref(field, value) {
  await updateProfile({ stores, usersId: me, communityKey, updates: { [field]: value } })
  myProfile = { ...myProfile, [field]: value }
  log(`${field} = ${value}`)
}

/** Lopende verzoeken tussen mij en `targetId` opruimen ("block & clear"). */
async function clearMutualProposals(targetId) {
  const props = (await stores.proposals.all()).map((e) => e.value)
  for (const p of props) {
    if ((p.giver === me && p.receiver === targetId) || (p.giver === targetId && p.receiver === me)) {
      if (await stores.proposals.get(p.pid)) await stores.proposals.del(p.pid)
    }
  }
}

async function blockUser(targetId) {
  await addToList({ stores, ownerId: me, targetId, listType: BLACKLIST })
  await clearMutualProposals(targetId)
  log(`#${targetId} geblokkeerd (verzoeken opgeruimd).`)
  await render()
}
async function unblockUser(targetId) {
  await removeFromList({ stores, ownerId: me, targetId, listType: BLACKLIST })
  log(`#${targetId} gedeblokkeerd.`); await render()
}
async function allowUser(targetId) {
  await addToList({ stores, ownerId: me, targetId, listType: WHITELIST })
  log(`#${targetId} toegestaan.`); await render()
}
async function removeAllow(targetId) {
  await removeFromList({ stores, ownerId: me, targetId, listType: WHITELIST })
  await clearMutualProposals(targetId) // uit witte lijst = effectief blokkeren
  log(`#${targetId} uit witte lijst.`); await render()
}
async function setPrivacyMode(mode) {
  await updateProfile({ stores, usersId: me, communityKey, updates: { useWhitelist: mode } })
  myProfile = { ...myProfile, useWhitelist: mode }
  log(`Privacy-modus: ${mode === 1 ? 'witte lijst' : 'zwarte lijst'}.`)
  await render()
}

let pendingImage = '' // de (nog niet opgeslagen) gekozen profielfoto in bewerkmodus

/** Update de foto-preview + zichtbaarheid van 'verwijderen' in bewerkmodus. */
function refreshImagePreview() {
  $('peImgPreview').src = avatarFor({ ...myProfile, usersId: me, image: pendingImage })
  $('peImgClear').style.display = (typeof pendingImage === 'string' && pendingImage.startsWith('data:image')) ? 'inline-block' : 'none'
}

/** Bewerkmodus openen (alleen eigen profiel): velden vullen uit myProfile. */
function enterProfileEdit() {
  profileEditing = true
  $('profEditInfo').textContent = ''
  $('peNewEmail').value = ''; $('peEmailInfo').textContent = ''; $('emailChangeBox').open = false
  pendingImage = myProfile.image || ''
  refreshImagePreview()
  $('peName').value = myProfile.usersName || ''
  $('peUid').value = myProfile.usersUid || ''
  $('peEmail').value = myProfile.usersEmail || ''
  $('peBirthday').value = (myProfile.birthday || '').slice(0, 10)
  $('peHeight').value = myProfile.height || ''
  fillSelect('peGender', genderLabels(), Number(myProfile.gender) || 0)
  fillSelect('peHair', hairLabels(), Number(myProfile.hair) || 0)
  fillSelect('peLeftEye', eyeLabels(), Number(myProfile.leftEye) || 0)
  fillSelect('peRightEye', eyeLabels(), Number(myProfile.rightEye) || 0)
  $('peSpecial').value = myProfile.specialFeatures || ''
  $('profView').classList.add('hidden')
  $('profEdit').classList.remove('hidden')
}

function cancelProfileEdit() {
  profileEditing = false
  $('profEdit').classList.add('hidden')
  $('profView').classList.remove('hidden')
  render().catch(() => {})
}

/**
 * E-mailadres wijzigen mét verificatie (hergebruikt de signup-verificatieflow). De
 * mailer dwingt uniciteit af op de account-pubkey; pas ná bevestiging via de mail
 * werken we `usersEmail` bij. Login/herstel lezen de e-mail uit het user-doc, dus
 * voortaan log je in met het nieuwe adres; de herstelcode blijft ongewijzigd.
 */
async function changeEmail() {
  const info = (m) => { $('peEmailInfo').textContent = m }
  const btn = $('peEmailVerifyBtn'); btn.disabled = true
  try {
    const newEmail = $('peNewEmail').value.trim().toLowerCase()
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(newEmail)) throw new Error('ongeldig e-mailadres')
    if (newEmail === (myProfile.usersEmail || '').toLowerCase()) throw new Error('dit is al je huidige e-mailadres')
    const pubkey = myProfile.pubkey
    if (!pubkey) throw new Error('account-sleutel onbekend — log opnieuw in')

    info('Verificatiemail aanvragen…')
    const r = await apiFetch('/api/email/start', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: newEmail, pubkey, usersId: me }),
    })
    if (r.status === 409) throw new Error('dit e-mailadres is al in gebruik')
    if (!r.ok) throw new Error('verificatie-aanvraag mislukt — probeer het nog eens')
    info('✉ Check je nieuwe mailbox — vul de verificatiecode in (kijk ook in spam).')
    await confirmEmailByCode(newEmail, pubkey, info)

    info('Bevestigd ✓ — e-mailadres bijwerken…')
    await updateProfile({ stores, usersId: me, communityKey, updates: { usersEmail: newEmail } })
    myProfile = { ...myProfile, usersEmail: newEmail }
    $('peEmail').value = newEmail
    $('peNewEmail').value = ''
    info('E-mailadres gewijzigd ✓ — log voortaan in met je nieuwe e-mail.')
    log('E-mailadres gewijzigd naar ' + newEmail)
  } catch (e) {
    info('FOUT: ' + e.message)
  } finally {
    btn.disabled = false
  }
}

/** Profielwijzigingen opslaan (versleuteld), myProfile verversen, terug naar bekijken. */
async function saveProfile() {
  const info = (m) => { $('profEditInfo').textContent = m }
  const btn = $('profHeaderSave'); btn.disabled = true
  try {
    const uid = $('peUid').value.trim()
    if (uid.length <= 3) throw new Error('gebruikersnaam moet langer dan 3 tekens zijn')
    const updates = {
      usersName: $('peName').value.trim(),
      usersUid: uid,
      birthday: $('peBirthday').value, // '' of 'JJJJ-MM-DD'
      height: $('peHeight').value.trim(),
      gender: Number($('peGender').value) || 0,
      hair: Number($('peHair').value) || 0,
      leftEye: Number($('peLeftEye').value) || 0,
      rightEye: Number($('peRightEye').value) || 0,
      specialFeatures: $('peSpecial').value.trim(),
      image: pendingImage, // profielfoto (data-URI) of '' om te verwijderen
      // usersEmail bewust niet: wijzigen vereist verificatie (apart)
    }
    info('Opslaan…')
    await updateProfile({ stores, usersId: me, updates, communityKey })
    myProfile = { ...myProfile, ...updates }
    profileEditing = false
    $('profEdit').classList.add('hidden')
    $('profView').classList.remove('hidden')
    await render()
    info('')
    log('Profiel bijgewerkt ✓')
  } catch (e) {
    info('FOUT: ' + (e.message === 'usernametaken' ? 'die gebruikersnaam is al in gebruik' : e.message))
  } finally {
    btn.disabled = false
  }
}

async function confirmPay(proposal) {
  log(`Betalen aan #${proposal.receiver}: ${proposal.amount}…`)
  const usersOld = (await stores.usersOld.all()).map((e) => e.value)
  const res = await payProposal({ stores, proposal, usersOldRows: usersOld, asOf: new Date() })
  log(res.paid ? `Betaald (tid ${res.tx.tid}).` : `Geweigerd: ${res.reason} (saldo ${res.available.toFixed(2)}).`)
  await render()
}

/**
 * Wachtwoord resetten via de e-mail-herstelkluis (optie 2): e-mail + herstelcode
 * ontsleutelen de seed uit `recovery`, daarna stellen we een nieuw wachtwoord in
 * (verse keystore). Volledig serverloos — de relay heeft de seed nooit.
 */
async function doReset() {
  const info = (m) => { $('resetInfo').textContent = m }
  const btn = $('resetBtn'); btn.disabled = true
  try {
    const email = $('resetEmail').value.trim()
    const code = normalizeRecoveryCode($('resetCode').value)
    const pwd = $('resetPwd').value
    if (!email) throw new Error('vul je e-mailadres in')
    if (!code) throw new Error('vul je herstelcode in')
    const pwdErr = validatePassword(pwd)
    if (pwdErr) throw new Error(pwdErr)
    if (pwd !== $('resetPwd2').value) throw new Error('de nieuwe wachtwoorden komen niet overeen')

    info('Verbinden…')
    await ensureSession()
    info('Account opzoeken…')
    let rec = null
    await waitFor(async () => {
      rec = await findUserByIdentifier((await stores.users.all()).map((e) => e.value), email, communityKey)
      return !!rec
    }, 'account-lookup', 30000).catch(() => {})
    if (!rec) throw new Error('geen account met dat e-mailadres')
    if (!rec.recovery) throw new Error('dit account heeft geen herstelkluis')
    let seed
    try {
      seed = await openKeystore(rec.recovery, code)
    } catch { throw new Error('verkeerde herstelcode') }
    me = rec.usersId

    info('Herstelcode ✓ — nieuw wachtwoord instellen…')
    await rekeyAuth({ stores, seed, usersId: me, newPassword: pwd })
    info('Wachtwoord opnieuw ingesteld ✓ — je wordt ingelogd…')
    await finishLogin()
  } catch (e) {
    info('FOUT: ' + e.message)
    btn.disabled = false
  }
}

/** Uitloggen: node afsluiten en de pagina herladen (alle sleutels/seed uit het geheugen). */
async function logout() {
  log('Uitloggen…')
  try { location.hash = '#/' } catch {}
  try { sessionStorage.removeItem('abundomy-me') } catch {}
  try { await node?.orbitdb?.stop() } catch {}
  try { await node?.ipfs?.stop() } catch {}
  location.reload()
}

/** Hervat een bewaarde sessie na (her)laden — geen wachtwoord nodig (al geverifieerd). */
async function tryResume() {
  let saved = null
  try { saved = sessionStorage.getItem('abundomy-me') } catch {}
  if (!saved) return
  me = Number(saved)
  $('login').classList.add('hidden')
  try {
    log('Sessie hervatten…')
    await ensureSession()
    await waitFor(async () => !!(await stores.users.get(me))?.value, 'eigen account', 30000)
    await finishLogin()
  } catch (e) {
    log('Hervatten mislukt: ' + e.message)
    try { sessionStorage.removeItem('abundomy-me') } catch {}
    $('login').classList.remove('hidden')
  }
}

async function exportChain(userId = me) {
  const csv = await exportUserChain({ stores, userId, communityKey, asOf: new Date() })
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
  const a = document.createElement('a')
  a.href = url; a.download = `${String(userId).padStart(10, '0')}-abundomy.csv`; a.click()
  URL.revokeObjectURL(url)
  log('Keten geëxporteerd.')
}

/** "07 Jun 2026 07:05:09" — volledige datum met seconden (zoals de legacy-PDF). */
function fmtFullDate(s) {
  const d = txDate(s)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getUTCDate())} ${monthsShort()[d.getUTCMonth()]} ${d.getUTCFullYear()} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
}

/**
 * PDF transactie-overzicht — serverloze tegenhanger van legacy `generate-pdf.inc.php`
 * (TCPDF). We openen een printvriendelijk venster; de browser maakt er via 'Opslaan
 * als PDF' een echte PDF van. Toont ALLE transacties van de getoonde gebruiker
 * (nieuwste eerst), met per transactie de volledige opbouw: uren · solidariteit ·
 * reductie · betaling · nieuw saldo (1-op-1 met `previousTransactionState`).
 *
 * RONDE 2: + ronde avatars (eigen + tegenpartij), + profielblok (lengte/geslacht/
 * haar/ogen/geboortedatum/bijzondere kenmerken, vertaalde kleurnamen), + brug-regel
 * 'sinds laatste transactie tot nu'. Labels vallen voor niet-EN/NL talen terug op EN.
 */
async function printStatement({ from, to, history } = {}) {
  // Venster METEEN openen (binnen het klik-gebaar) — anders blokkeert de pop-upfilter
  // het na de async data-ophaal. Daarna vullen we het.
  const w = window.open('', '_blank')
  if (!w) { log('Pop-up geblokkeerd — sta pop-ups toe om de PDF te maken.'); return }
  w.document.write('<!doctype html><meta charset="utf-8"><title>Overzicht</title>' +
    '<body style="font:14px Arial,sans-serif;margin:32px;color:#555">Overzicht voorbereiden…</body>')

  const uid = txUserId ?? me
  const allFull = await userTransactions(uid) // oplopend op tijd (volledige keten)
  // Optioneel datumbereik: filter de getoonde rijen op [from, to] (datum-inclusief).
  // De saldo-/uren-berekening blijft op de VOLLEDIGE keten (previousTransactionState),
  // zodat 'nieuw saldo' historisch klopt; alleen welke rijen we tónen wordt gefilterd.
  const fromMs = from ? parseSqlDate(from + ' 00:00:00').getTime() : -Infinity
  const toMs = to ? parseSqlDate(to + ' 23:59:59').getTime() : Infinity
  const ranged = !!(from || to)
  const all = ranged
    ? allFull.filter((tx) => { const ms = parseSqlDate(tx.time_stamp).getTime(); return ms >= fromMs && ms <= toMs })
    : allFull
  const users = (await stores.users.all()).map((e) => e.value)
  const usersOld = (await stores.usersOld.all()).map((e) => e.value)
  const joined = joinedDate(users.find((u) => u.usersId === uid) ?? { usersId: uid, start: allFull[0]?.time_stamp }, usersOld)
  const name = $('txViewName').textContent || `#${uid}`
  const liveBal = availableCoins({ joined, transactions: allFull, userId: uid, asOf: new Date() })

  // Volledig profiel van de getoonde gebruiker (eigen is al ontsleuteld) — voor de
  // header-avatar én het profielblok.
  const byId = new Map(users.map((u) => [u.usersId, u]))
  const viewer = uid === me ? { ...myProfile, usersId: uid } : await safeProfile(byId.get(uid) ?? { usersId: uid })

  // Profielen van de tegenpartijen ontsleutelen → naam + avatar.
  const partners = new Map()
  for (const pid of new Set(allFull.map((tx) => (tx.giver === uid ? tx.receiver : tx.giver)))) {
    const doc = byId.get(pid)
    partners.set(pid, doc ? { ...(await safeProfile(doc)), usersId: pid } : { usersId: pid, usersName: `#${pid}` })
  }

  // Logo (coin) inline als data-URI — de print-pop-up is about:blank, dus relatieve
  // paden lossen niet op; we halen 'm op t.o.v. de app-locatie en bakken 'm in.
  let logoSrc = ''
  try {
    const r = await fetch('img/1CoinH_140x140.png')
    if (r.ok) { const b = await r.blob(); logoSrc = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(b) }) }
  } catch {}

  const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
  const U = 'ᕫ'
  // Bedragnotatie als het origineel: spatie-duizendtallen + punt-decimaal ("10 283.26").
  const fmtPdf = (n) => formatCoins(n).replace(/,/g, ' ')
  // Bedrag met teken, kleur en munt-symbool (blauw = bij, rood = af) — als de legacy fmt().
  const amt = (v, bold = false) => {
    const pos = v >= 0
    const txt = `${pos ? '+' : '−'}${fmtPdf(Math.abs(v))}&nbsp;${U}`
    return `<span class="num" style="color:${pos ? '#0055aa' : '#aa0000'}">${bold ? `<b>${txt}</b>` : txt}</span>`
  }
  // Eén waarde-cel: bedrag + klein label ernaast (bv. "+24.98 ᕫ Solidarity").
  const cell = (valHtml, label) => `<div class="cell">${valHtml} <span class="cap">${esc(label)}</span></div>`
  const pav = (p) => `<img class="pav" src="${avatarFor(p)}" alt="" />`

  const acc = formatDisplayNum(uid)
  const rowsHtml = [...all].reverse().map((tx) => {
    const isGiver = tx.giver === uid
    const st = previousTransactionState(allFull, uid, tx.time_stamp, joined)
    const vPay = isGiver ? -tx.amount : tx.amount
    const newBal = st.availableBalance + vPay
    const solidarity = st.income + st.reductionAmount // netto effect (bruto inkomen − reductie)
    const partner = partners.get(isGiver ? tx.receiver : tx.giver)
    return `<div class="tx">` +
      `<div class="meta">${acc} &nbsp;|&nbsp; ${fmtFullDate(tx.time_stamp)}</div>` +
      cell(`<span class="num">${st.hours}</span>`, t('TR_HOURS')) +
      cell(amt(solidarity), t('TR_SOLIDARITY')) +
      `<div class="pname">${pav(partner)}${esc(partner.usersName || `#${partner.usersId}`)}</div>` +
      cell(amt(st.reductionAmount), t('TR_REDUCTION')) +
      cell(amt(vPay), t('TR_PAYMENT')) +
      `<div class="pdesc">${esc(tx.description || '')}</div>` +
      cell(amt(st.income), t('TR_INCOME')) +
      cell(amt(newBal, true), t('TR_NEW_BAL')) +
      `</div>`
  }).join('')

  // Brug-regel: aangroei (uren/solidariteit/reductie/inkomen) sinds de laatste
  // transactie tot NU; 'nieuw saldo' = live saldo. Zelfde opbouw als een tx-rij,
  // betaling 0. Bovenaan (nieuwste eerst). (1-op-1 met de brug in renderCalc.)
  const nowSql = new Date().toISOString().slice(0, 19).replace('T', ' ')
  let bridgeRow = ''
  if (!ranged && allFull.length) {
    const bst = previousTransactionState(allFull, uid, nowSql, joined)
    bridgeRow = `<div class="tx bridge">` +
      `<div class="meta">${esc(t('TR_SINCE_LAST'))} &nbsp;|&nbsp; ${fmtFullDate(nowSql)}</div>` +
      cell(`<span class="num">${bst.hours}</span>`, t('TR_HOURS')) +
      cell(amt(bst.income + bst.reductionAmount), t('TR_SOLIDARITY')) +
      `<div class="pname">—</div>` +
      cell(amt(bst.reductionAmount), t('TR_REDUCTION')) +
      cell(amt(0), t('TR_PAYMENT')) +
      `<div class="pdesc"></div>` +
      cell(amt(bst.income), t('TR_INCOME')) +
      cell(amt(bst.availableBalance, true), t('TR_NEW_BAL')) +
      `</div>`
  }

  // Start-regel: het basis-startgift (1000 ᕫ) op de inschrijfdatum. Alleen bij het
  // volledige overzicht — bij een datumbereik hoort die regel niet bij de periode.
  const startRow = ranged ? '' : `<div class="tx start">` +
    `<div class="meta">${acc} &nbsp;|&nbsp; ${fmtFullDate(joined)}</div>` +
    `<div></div><div></div><div></div><div></div><div></div>` +
    `<div></div>${cell(amt(1000, true), t('PDF_OPENING_BAL'))}` +
    `</div>`

  // Profielblok (1-op-1 met renderProfile): vertaalde haar-/oogkleur + geslacht.
  const fld = (label, val) => `<div class="pf"><span class="pfk">${esc(label)}</span><span class="pfv">${esc(val)}</span></div>`
  const profileBlock =
    `<div class="profile"><img class="pavbig" src="${avatarFor(viewer)}" alt="" /><div class="pfg">` +
    fld(t('SU_BD'), formatDateNL(viewer.birthday)) +
    fld(t('SU_GN'), genderLabels()[viewer.gender] ?? '—') +
    fld(t('SU_HT'), viewer.height || '—') +
    fld(t('SU_HR'), hairLabels()[viewer.hair] ?? (viewer.hair ?? '—')) +
    fld(t('SU_LE'), eyeLabels()[viewer.leftEye] ?? (viewer.leftEye ?? '—')) +
    fld(t('SU_RE'), eyeLabels()[viewer.rightEye] ?? (viewer.rightEye ?? '—')) +
    fld(t('SU_SF'), viewer.specialFeatures || '—') +
    `</div></div>`

  // Profielhistorie (optioneel, checkbox): de in `users_old` gearchiveerde OUDE
  // profielversies van deze gebruiker, chronologisch (oudste eerst). Alleen échte
  // snapshots (met `enc`); de slank-gemigreerde join-only rijen (enkel start_old)
  // hebben geen profielvelden → overslaan. Elke versie toont z'n geldigheidsperiode.
  let historyBlock = ''
  if (history) {
    const snaps = usersOld
      .filter((o) => o.uid_old === uid && o.enc)
      .sort((a, b) => (a.start_old < b.start_old ? -1 : a.start_old > b.start_old ? 1 : 0))
    const cards = []
    for (const s of snaps) {
      const v = await safeProfile(s)
      const period = `${formatDateNL(s.start_old)} – ${formatDateNL(s.end_old)}`
      cards.push(
        `<div class="profile hist"><img class="pavbig" src="${avatarFor({ ...v, usersId: uid })}" alt="" /><div class="pfg">` +
        `<div class="pf histtop"><span class="histname">${esc(v.usersName || `#${uid}`)}</span><span class="histcap">${esc(period)}</span></div>` +
        fld(t('SU_BD'), formatDateNL(v.birthday)) +
        fld(t('SU_GN'), genderLabels()[v.gender] ?? '—') +
        fld(t('SU_HT'), v.height || '—') +
        fld(t('SU_HR'), hairLabels()[v.hair] ?? (v.hair ?? '—')) +
        fld(t('SU_LE'), eyeLabels()[v.leftEye] ?? (v.leftEye ?? '—')) +
        fld(t('SU_RE'), eyeLabels()[v.rightEye] ?? (v.rightEye ?? '—')) +
        fld(t('SU_SF'), v.specialFeatures || '—') +
        `</div></div>`,
      )
    }
    if (cards.length) historyBlock = `<h2 class="histh">${esc(t('PDF_LBL_HISTORY'))}</h2>` + cards.join('')
  }

  const printDate = fmtFullDate(nowSql)
  const logoImg = logoSrc ? `<img class="logo" src="${logoSrc}" alt="" />` : ''
  // Kop + voet zitten in `position:fixed` blokken: bij printen tekent Chromium die op
  // ELKE pagina (per-pagina kop/voet). `@page`-marges reserveren de ruimte; op het
  // scherm doet body-padding hetzelfde. Paginanummers komen uit de browser-printvoet.
  const html = `<!doctype html><html lang="${getLang()}"><head><meta charset="utf-8" />` +
    `<title>${esc(name)} — ${esc(t('PDF_TRANSACTION_OVERVIEW'))}</title><style>` +
    `*{box-sizing:border-box}` +
    `@page{size:A4;margin:28mm 12mm 16mm;}` +
    `body{font-family:Arial,Helvetica,sans-serif;color:#111;margin:0;padding:28mm 12mm 16mm;}` +
    `.pageheader{position:fixed;top:0;left:0;right:0;background:#fff;padding:7mm 12mm 4px;}` +
    `.pagefooter{position:fixed;bottom:0;left:0;right:0;background:#fff;padding:4px 12mm 5mm;}` +
    `.head{display:flex;align-items:flex-start;justify-content:space-between;border-bottom:2px solid #916B01;padding-bottom:8px;}` +
    `.head .brand{display:flex;align-items:center;gap:9px;}` +
    `.logo{width:40px;height:40px;border-radius:50%;object-fit:cover;flex-shrink:0;}` +
    `.head h1{font-size:17px;margin:0;color:#916B01;}.head .sub{font-size:10px;color:#777;margin-top:2px;}` +
    `.head .right{display:flex;align-items:center;gap:10px;}` +
    `.avatar{width:46px;height:46px;border-radius:50%;object-fit:cover;border:1px solid #916B01;}` +
    `.acc{font-size:11px;color:#444;text-align:right;}.who{font-size:15px;font-weight:bold;text-align:right;margin-top:2px;}` +
    `.joined{font-size:10px;color:#aa0000;text-align:right;}` +
    `.balance{font-size:15px;margin:0 0 6px;}.balance b{color:#0055aa;}` +
    `.profile{display:flex;align-items:center;gap:14px;background:#faf6ea;border:1px solid #e6d9b0;border-radius:6px;` +
    `padding:10px 14px;margin:0 0 14px;page-break-inside:avoid;}` +
    `.pavbig{width:64px;height:64px;border-radius:50%;object-fit:cover;border:1px solid #916B01;flex-shrink:0;}` +
    `.pfg{display:grid;grid-template-columns:1fr 1fr;column-gap:24px;row-gap:2px;flex:1;}` +
    `.pf{font-size:10px;display:flex;justify-content:space-between;border-bottom:1px dotted #ddd;padding:1px 0;}` +
    `.pfk{color:#777;}.pfv{color:#222;font-weight:bold;}` +
    `.histh{font-size:12px;color:#916B01;margin:14px 0 6px;border-bottom:1px solid #e6d9b0;padding-bottom:3px;}` +
    `.profile.hist{background:#f4f7fb;border-color:#cdd8e6;margin:0 0 8px;}` +
    `.histtop{grid-column:1/-1;border-bottom:1px solid #cdd8e6;margin-bottom:2px;}` +
    `.histname{color:#222;font-weight:bold;font-size:11px;}.histcap{color:#777;font-size:9px;}` +
    `.tx{display:grid;grid-template-columns:1.45fr 1fr 1.15fr;grid-auto-rows:auto;column-gap:10px;row-gap:1px;` +
    `border-top:1px solid #bbb;padding:6px 0;page-break-inside:avoid;}` +
    `.tx.bridge{background:#f2f8ff;}` +
    `.meta{font-size:9px;color:#555;}.pname{font-size:12.5px;display:flex;align-items:center;}` +
    `.pdesc{font-size:10px;color:#555;}` +
    `.pav{width:18px;height:18px;border-radius:50%;object-fit:cover;margin-right:6px;flex-shrink:0;}` +
    `.cell{text-align:right;font-size:10px;white-space:nowrap;}.num{font-size:10.5px;}` +
    `.cap{color:#777;font-size:8px;margin-left:2px;}` +
    `.start .meta{color:#444;}` +
    `.foot{border-top:1px solid #916B01;padding-top:6px;font-size:9px;color:#916B01;` +
    `display:flex;justify-content:space-between;}` +
    `.empty{color:#888;font-style:italic;margin-top:18px;}` +
    `</style></head><body>` +
    `<div class="pageheader"><div class="head">` +
      `<div class="brand">${logoImg}<div><h1>${esc(t('TITLE'))} — ${esc(t('PDF_TRANSACTION_OVERVIEW'))}</h1>` +
      `<div class="sub">${esc(ranged ? `${t('PDF_FROM')} ${from || '…'} ${t('PDF_TO')} ${to || '…'}` : t('PDF_LBL_ALL'))}</div></div></div>` +
      `<div class="right"><img class="avatar" src="${avatarFor(viewer)}" alt="" />` +
      `<div><div class="acc">${acc}</div><div class="who">${esc(name)}</div>` +
      `<div class="joined">${fmtFullDate(joined)}</div></div></div></div></div>` +
    profileBlock +
    historyBlock +
    `<div class="balance">${esc(t('PDF_BALANCE'))}:&nbsp; <b>+${fmtPdf(liveBal)}&nbsp;${U}</b></div>` +
    (all.length ? bridgeRow + rowsHtml + startRow : `<p class="empty">${esc(t('TR_NONE'))}</p>`) +
    `<div class="pagefooter"><div class="foot"><span>${printDate}</span>` +
    `<a href="https://www.abundomy.com" style="color:#916B01;text-decoration:none;">www.abundomy.com</a></div></div>` +
    `</body></html>`

  w.document.open(); w.document.write(html); w.document.close(); w.focus()
  setTimeout(() => { try { w.print() } catch {} }, 350) // even tijd om te renderen
  log(`PDF-overzicht ${name} geopend (${all.length} transacties) — kies 'Opslaan als PDF'.`)
}

fetch('relay.json').then((r) => r.ok ? $('relayInfo').textContent = 'Relay gevonden ✓ — klaar om te verbinden.'
  : $('relayInfo').textContent = '⚠ Geen relay.json — draai eerst `npm run relay`.')
  .catch(() => $('relayInfo').textContent = '⚠ Geen relay.json — draai eerst `npm run relay`.')

const doLogin = () => loginWithPassword().catch((e) => log('FOUT: ' + e.message))
$('loginBtn').onclick = doLogin
for (const id of ['loginId', 'loginPwd']) {
  $(id).onkeydown = (e) => {
    if (e.key !== 'Enter' || e.isComposing) return // isComposing: IME-invoer nog niet af
    e.preventDefault()
    if (!$('loginBtn').disabled) doLogin()
  }
}
$('signupBtn').onclick = () => doSignup().catch((e) => log('FOUT: ' + e.message))
const showCard = (id) => {
  for (const c of ['login', 'signup', 'resetCard']) $(c).classList.toggle('hidden', c !== id)
  // Punt 04-foto: op signup → avatar ipv vlag (taal alleen op home vóór inlog, per Patrick); elders → vlag.
  const onSignup = (id === 'signup')
  $('suAvatar').style.display = onSignup ? 'block' : 'none'
  $('langFlag').style.display = onSignup ? 'none' : 'block'
  if (onSignup) $('suAvatar').src = avatarFor({ usersName: $('suName').value, image: signupImage })
}
$('toSignupBtn').onclick = () => {
  // 05 (Registratie): e-mail + wachtwoord 1x meenemen naar signup. E-mail alleen als loginId een @ bevat.
  const lid = $('loginId').value.trim()
  if (lid.includes('@')) $('suEmail').value = lid
  const lpw = $('loginPwd').value
  if (lpw) $('suPwd').value = lpw
  showCard('signup')
}
$('toResetBtn').onclick = () => showCard('resetCard')
$('resetBackBtn').onclick = () => showCard('login')
if ($('toLogin')) $('toLogin').onclick = (e) => { e.preventDefault(); showCard('login') }
$('suCancelBtn').onclick = () => showCard('login')
$('resetBtn').onclick = () => doReset().catch((e) => log('FOUT: ' + e.message))
$('logoutBtn').onclick = () => logout().catch((e) => log('FOUT: ' + e.message))
// Zoeken: knop dood onder de 3 tekens, Enter zoekt, elke zoekopdracht begint op pagina 1.
const doSearch = () => {
  searchQuery = ($('searchInput').value || '').trim()
  searchStart = 0
  searchDone = true
  render().catch((e) => log('FOUT: ' + e.message))
}
$('searchInput').oninput = updateSearchBtn
$('searchInput').onkeydown = (e) => { if (e.key === 'Enter' && !$('searchBtn').disabled) doSearch() }
$('searchBtn').onclick = doSearch
// Verzoek: bedrag live opmaken/valideren, verzenden.
$('rcvAmount').oninput = () => checkAmount(rcvAvail)
$('rcvSendBtn').onclick = () => sendRequest()
if ($('exportBtn')) $('exportBtn').onclick = () => exportChain().catch((e) => log('FOUT: ' + e.message))
$('txPdfBtn').onclick = () => $('pdfOpts').classList.toggle('hidden') // toon/verberg opties
$('pdfGenBtn').onclick = () => {
  const scope = document.querySelector('input[name="pdfScope"]:checked')?.value || 'all'
  const history = $('pdfHistory').checked
  const opts = scope === 'range' ? { from: $('pdfFrom').value, to: $('pdfTo').value, history } : { history }
  printStatement(opts).catch((e) => log('FOUT: ' + e.message))
}
$('txCsvBtn').onclick = () => exportChain(txUserId ?? me).catch((e) => log('FOUT: ' + e.message))
$('refreshBtn').onclick = () => { log('Verversen (verse sync)…'); location.reload() }
$('changePwdBtn').onclick = () => doChangePassword().catch((e) => log('FOUT: ' + e.message))
$('goDashboard').onclick = () => finishLogin().catch((e) => log('FOUT: ' + e.message))
window.addEventListener('hashchange', () => route())
$('profEditBtn').onclick = () => enterProfileEdit()
$('profRevPrev').onclick = () => { if (revIdx < revVersions.length - 1) { revIdx++; renderProfileVersion() } } // ouder
$('profRevNext').onclick = () => { if (revIdx > 0) { revIdx--; renderProfileVersion() } } // nieuwer
$('profHeaderSave').onclick = () => saveProfile().catch((e) => log('FOUT: ' + e.message))
$('profHeaderBack').onclick = () => history.back()
$('peImgFile').onchange = async (e) => {
  const file = e.target.files?.[0]; if (!file) return
  try { pendingImage = await fileToAvatarDataURL(file); refreshImagePreview() }
  catch (err) { $('profEditInfo').textContent = 'FOUT: ' + err.message }
  e.target.value = '' // zelfde bestand opnieuw kiezen blijft mogelijk
}
$('peImgClear').onclick = () => { pendingImage = ''; refreshImagePreview() }
$('peEmailVerifyBtn').onclick = () => changeEmail().catch((e) => log('FOUT: ' + e.message))

// Foto kiezen bij signup (vóór account-aanmaak).
let signupImage = ''
function refreshSignupImagePreview() {
  // Punt 04-foto stap 3: avatar (topNav, ipv vlag) updaten met de gekozen foto / naam-placeholder.
  $('suAvatar').src = avatarFor({ usersName: $('suName').value, image: signupImage })
}
$('suPhotoBtn').onclick = () => showViewImage('signup')  // Punt 04-foto: opent V1 image.php-achtige view (was direct file-picker)
$('suName').addEventListener('input', () => { if (!signupImage) refreshSignupImagePreview() })
refreshSignupImagePreview()

// Punt 04-24-07: signup-form persistentie bij refresh (wachtwoord NIET opslaan, per Patrick keuze 3).
const SIGNUP_FORM_KEY = 'abundomy-signup-form'
const SIGNUP_FIELDS = ['suName','suEmail','suUid','suBirthday','suGender','suHeight','suHair','suLeftEye','suRightEye','suSpecial']
function saveSignupForm() {
  try {
    const data = {}
    for (const id of SIGNUP_FIELDS) data[id] = $(id).value
    data.signupImage = signupImage
    localStorage.setItem(SIGNUP_FORM_KEY, JSON.stringify(data))
  } catch {}
}
function restoreSignupForm() {
  try {
    const data = JSON.parse(localStorage.getItem(SIGNUP_FORM_KEY) || '{}')
    if (!data || typeof data !== 'object') return
    for (const id of SIGNUP_FIELDS) if (id in data && data[id] != null) $(id).value = data[id]
    signupImage = data.signupImage || ''
    refreshSignupImagePreview()
  } catch {}
}
function clearSignupForm() { try { localStorage.removeItem(SIGNUP_FORM_KEY) } catch {} }
$('signup').addEventListener('input', saveSignupForm)
$('signup').addEventListener('change', saveSignupForm)

// Punt 04-foto stap 1: #view-image (V1 image.php-layout). Upload → canvas → terug. Webcam/bewerking = stap 2.
let imageViewReturnTo = 'signup'
// Punt foto-flow stap 1: paspartout (zwart + rode selector) bij openen — zoals 1coinh image.php.
// === Image-edit core (V1 image.js-port, stap 2) ===
const IE = { img: null, imageWidth: 0, imageHeight: 0, imw: 0, imh: 0, rot: 0, focx: 0, focy: 0, ox: 0, oy: 0, scale: 100, co: 100, br: 100, sa: 100, ww: 350, hh: 250, preload: true, zoomVal: 50, contrastVal: 50, brightnessVal: 50, colorVal: 50 }
const IE_PORT = { x1: (350 - 140) / 2, y1: (250 - 140) / 2, x2: (350 + 140) / 2, y2: (250 + 140) / 2 }
function drawBack() {
  const x = $('imgCanvas').getContext('2d'), x2 = $('canvas2').getContext('2d')
  x.fillStyle = '#000'; x.fillRect(0, 0, 350, 250)
  x2.fillStyle = '#000'; x2.fillRect(0, 0, 350, 250)
}
function drawPaspartout() {
  const x = $('imgCanvas').getContext('2d'), { x1, y1, x2, y2 } = IE_PORT, L = 40
  x.fillStyle = 'rgba(2,2,2,0.8)'
  x.fillRect(0, 0, 350, y1); x.fillRect(0, y1, x1, y2 - y1); x.fillRect(x2, y1, 350 - x2, y2 - y1); x.fillRect(0, y2, 350, 250 - y2)
  x.beginPath(); x.lineWidth = 2; x.strokeStyle = '#ff0000'
  x.moveTo(x1 - 1, y1 + L); x.lineTo(x1 - 1, y1 - 1); x.lineTo(x1 + L, y1 - 1)
  x.moveTo(x2 - L, y1 - 1); x.lineTo(x2 + 1, y1 - 1); x.lineTo(x2 + 1, y1 + L)
  x.moveTo(x2 + 1, y2 - L); x.lineTo(x2 + 1, y2 + 1); x.lineTo(x2 - L, y2 + 1)
  x.moveTo(x1 + L, y2 + 1); x.lineTo(x1 - 1, y2 + 1); x.lineTo(x1 - 1, y2 - L)
  x.stroke()
}
function drawImg() {
  if (IE.preload) return
  const x = $('imgCanvas').getContext('2d'), x2 = $('canvas2').getContext('2d'), c2 = $('canvas2')
  const ww = IE.ww, hh = IE.hh
  x2.filter = `contrast(${IE.co}%) brightness(${IE.br}%) saturate(${IE.sa}%)`
  let ccx, ccy, cwx, cwy
  if (IE.rot !== 0) {
    x2.save()
    if (IE.rot === 1) x2.translate(Math.round(ww / 2 + hh / 2), Math.round(hh / 2 - ww / 2))
    else if (IE.rot === 2) x2.translate(ww, hh)
    else x2.translate(Math.round(ww / 2 - hh / 2), Math.round(ww / 2 + hh / 2))
    x2.rotate(IE.rot * Math.PI * 0.5)
    const imw2 = IE.imw
    IE.imw = Math.round(IE.imageWidth * IE.scale / 100)
    IE.imh = Math.round(IE.imageHeight * IE.scale / 100)
    if (imw2) { IE.focx = Math.round(IE.focx * (IE.imw / imw2)); IE.focy = Math.round(IE.focy * (IE.imw / imw2)) }
    IE.ox = Math.round(ww / 2) - IE.focx; IE.oy = Math.round(hh / 2) - IE.focy
    x2.drawImage(IE.img, IE.ox, IE.oy, IE.imw, IE.imh)
    if (IE.rot === 1) { ccx = (Math.round(ww / 2) + Math.round(hh / 2)) - (IE.oy + IE.imh); ccy = (Math.round(hh / 2) - Math.round(ww / 2)) + IE.ox; cwx = IE.imh; cwy = IE.imw }
    else if (IE.rot === 2) { ccx = ww - (IE.ox + IE.imw); ccy = hh - (IE.oy + IE.imh); cwx = IE.imw; cwy = IE.imh }
    else { ccx = (Math.round(ww / 2) - Math.round(hh / 2)) + IE.oy; ccy = (Math.round(hh / 2) + Math.round(ww / 2)) - (IE.ox + IE.imw); cwx = IE.imh; cwy = IE.imw }
    x2.restore()
  } else {
    const imw2 = IE.imw
    IE.imw = Math.round(IE.imageWidth * IE.scale / 100)
    IE.imh = Math.round(IE.imageHeight * IE.scale / 100)
    if (imw2) { IE.focx = Math.round(IE.focx * (IE.imw / imw2)); IE.focy = Math.round(IE.focy * (IE.imw / imw2)) }
    IE.ox = Math.round(ww / 2) - IE.focx; IE.oy = Math.round(hh / 2) - IE.focy
    x2.drawImage(IE.img, IE.ox, IE.oy, IE.imw, IE.imh)
    ccx = IE.ox; ccy = IE.oy; cwx = IE.imw; cwy = IE.imh
  }
  if (ccx < 0) { cwx += ccx; ccx = 0; if (cwx < 0) cwx = 0; if (cwx > ww) cwx = ww - 1 }
  if (ccy < 0) { cwy += ccy; ccy = 0; if (cwy < 0) cwy = 0; if (cwy > hh) cwy = hh - 1 }
  x.drawImage(c2, ccx, ccy, cwx, cwy, ccx, ccy, cwx, cwy)
}
function ieRedraw() { drawBack(); drawImg(); drawPaspartout() }
function initIE(img) {
  IE.img = img; IE.preload = false
  IE.imageWidth = img.width; IE.imageHeight = img.height
  IE.imw = img.width; IE.imh = img.height
  IE.focx = Math.round(img.width / 2); IE.focy = Math.round(img.height / 2)
  IE.rot = 0
  IE.scale = Math.round(Math.min(IE.ww / img.width, IE.hh / img.height) * 100 * 0.80)
  IE.co = 100; IE.br = 100; IE.sa = 100
  IE.zoomVal = 50; IE.contrastVal = 50; IE.brightnessVal = 50; IE.colorVal = 50
}
function rotateIt() { IE.rot = (IE.rot + 1) % 4; ieRedraw() }
function ieZoom(delta) { IE.zoomVal = Math.max(0, Math.min(100, IE.zoomVal + delta)); IE.scale = 100 * Math.pow(1.07, 50 - IE.zoomVal); ieRedraw() }
function ieReset() {
  IE.zoomVal = 50; IE.contrastVal = 50; IE.brightnessVal = 50; IE.colorVal = 50
  IE.co = 100; IE.br = 100; IE.sa = 100; IE.rot = 0
  if (IE.imageWidth) IE.scale = Math.round(Math.min(IE.ww / IE.imageWidth, IE.hh / IE.imageHeight) * 100 * 0.80)
  IE.focx = Math.round(IE.imageWidth / 2); IE.focy = Math.round(IE.imageHeight / 2)
  ieRedraw()
}
function ieFilter(kind, delta) {
  if (kind === 'co') IE.contrastVal = Math.max(0, Math.min(100, IE.contrastVal + delta))
  else if (kind === 'br') IE.brightnessVal = Math.max(0, Math.min(100, IE.brightnessVal + delta))
  else IE.colorVal = Math.max(0, Math.min(100, IE.colorVal + delta))
  IE.co = Math.round(100 * Math.pow(1.02, 50 - IE.contrastVal))
  IE.br = Math.round(100 * Math.pow(1.02, 50 - IE.brightnessVal))
  IE.sa = Math.round(100 * Math.pow(1.02, 50 - IE.colorVal))
  ieRedraw()
}
let ieDragging = false, ieMx1 = 0, ieMy1 = 0, ieTtx = 0, ieTty = 0
function ieDragFoc(dx, dy) {
  if (IE.rot === 0) { IE.focx += dx; IE.focy += dy }
  else if (IE.rot === 1) { IE.focx += dy; IE.focy -= dx }
  else if (IE.rot === 2) { IE.focx -= dx; IE.focy -= dy }
  else { IE.focx -= dy; IE.focy += dx }
  ieRedraw()
}
function ieMouseDown(e) { if (imageViewMode === 'edit') { ieMx1 = e.clientX; ieMy1 = e.clientY; ieDragging = true } }
function ieMouseMove(e) { if (imageViewMode === 'edit' && ieDragging) { ieDragFoc(ieMx1 - e.clientX, ieMy1 - e.clientY); ieMx1 = e.clientX; ieMy1 = e.clientY } }
function ieMouseUp() { ieDragging = false }
function ieTouchStart(e) { if (imageViewMode === 'edit' && e.touches[0]) { ieTtx = e.touches[0].clientX; ieTty = e.touches[0].clientY; e.preventDefault() } }
function ieTouchMove(e) { if (imageViewMode === 'edit' && e.touches[0]) { ieDragFoc(ieTtx - e.touches[0].clientX, ieTty - e.touches[0].clientY); ieTtx = e.touches[0].clientX; ieTty = e.touches[0].clientY; e.preventDefault() } }
$('imgResetBtn').onclick = ieReset
$('imgRotateBtn').onclick = rotateIt
$('zoomin').onclick = () => ieZoom(-1)
$('zoomout').onclick = () => ieZoom(1)
$('brightnessmax').onclick = () => ieFilter('br', -1)
$('brightnessmin').onclick = () => ieFilter('br', 1)
$('contrastmax').onclick = () => ieFilter('co', -1)
$('contrastmin').onclick = () => ieFilter('co', 1)
$('colormax').onclick = () => ieFilter('sa', -1)
$('colormin').onclick = () => ieFilter('sa', 1)
$('imgCanvas').addEventListener('mousedown', ieMouseDown)
$('imgCanvas').addEventListener('mousemove', ieMouseMove)
$('imgCanvas').addEventListener('mouseup', ieMouseUp)
$('imgCanvas').addEventListener('mouseout', ieMouseUp)
$('imgCanvas').addEventListener('touchstart', ieTouchStart, { passive: false })
$('imgCanvas').addEventListener('touchmove', ieTouchMove, { passive: false })
function showPaspartoutEmpty() { IE.preload = true; drawBack(); drawPaspartout() }
function showViewImage(returnTo) {
  imageViewReturnTo = returnTo || 'signup'
  for (const v of VIEWS) $('view-' + v)?.classList.add('hidden')
  $('signup').classList.add('hidden')
  $('view-image').classList.remove('hidden')
  setImageViewMode('choose')  // stap 1: zwart+rood + Foto/Klik (bewerkingstabel verborgen)
}
// 2-staps flow zoals 1coinh image.js: 'choose' (stap 1) ↔ 'edit' (stap 2 na foto/snap).
let imageViewMode = 'choose'
function setImageViewMode(mode) {
  imageViewMode = mode
  const ve = $('view-image')
  if (mode === 'edit') {
    ve.classList.add('edit-mode')
    $('imgUploadLbl').textContent = t('IMG_USE')   // 'Ready' (imgUploadBtn = save in stap 2)
    $('imgSnapLbl').textContent = t('IMG_ABORT')  // 'Afbreken' (imgSnapBtn = abort in stap 2)
  } else {
    ve.classList.remove('edit-mode')
    $('imgUploadLbl').textContent = t('IMG_GET')   // 'Foto'
    $('imgSnapLbl').textContent = t('IMG_SNAP')    // 'Klik'
    IE.preload = true
    drawBack(); drawPaspartout()  // zwart + rode selector (paspartout) in stap 1
  }
}
function closeViewImage() {
  webcamOff()  // webcam stoppen bij sluiten (geen live stream laten hangen)
  $('view-image').classList.remove('edit-mode')
  $('view-image').classList.add('hidden')
  showCard(imageViewReturnTo === 'profile' ? 'login' : 'signup')  // 'profile' later: echte profile-integratie (stap 3+)
}
// Punt 04-foto stap 3: avatar (topNav, ipv vlag) klikbaar → foto wijzigen.
// imgUploadBtn dubbelrol: choose → file picker; edit (Ready) → save (canvas→signupImage→close).
$('imgUploadBtn').onclick = () => {
  if (imageViewMode === 'edit') {
    if (IE.preload || !IE.img) { $('imgInstr').textContent = 'kies eerst een foto (Upload of Camera)'; return }
    // Clean redraw (zonder rode paspartout) → crop 140×140 paspartout-venster → opslaan.
    // De rode selector is een hulplijn bij maken/bewerken, niet in de opgeslagen foto.
    drawBack(); drawImg()
    const tmp = document.createElement('canvas'); tmp.width = 140; tmp.height = 140
    tmp.getContext('2d').drawImage($('imgCanvas'), IE_PORT.x1, IE_PORT.y1, 140, 140, 0, 0, 140, 140)
    signupImage = tmp.toDataURL('image/png')
    drawPaspartout()  // weergave herstellen (rode selector terug voor gebruiker)
    if (imageViewReturnTo === 'signup') {
      saveSignupForm()
      closeViewImage()
      refreshSignupImagePreview()
    }
  } else {
    $('loadpicture').click()
  }
}
// loadpicture: foto gekozen → drawImageOnCanvas + stap 2 (edit-mode).
$('loadpicture').onchange = (e) => {
  const f = e.target.files?.[0]; if (!f) return
  const img = new Image()
  img.onload = () => { initIE(img); ieRedraw(); setImageViewMode('edit') }
  img.src = URL.createObjectURL(f)
  e.target.value = ''
}
$('imgCancelBtn').onclick = () => closeViewImage()
// webcam-snap (foto maken) via getUserMedia.
let webcamStream = null
function webcamOff() {
  if (webcamStream) { webcamStream.getTracks().forEach((track) => track.stop()); webcamStream = null }
  const v = $('webcamVideo'); if (v) { v.style.display = 'none'; v.srcObject = null }
  // label wordt gezet door setImageViewMode (afhankelijk van mode), niet hier.
}
// imgSnapBtn dubbelrol: choose → camera toggle (Klik→Opname→snap→edit); edit (Afbreken) → abort (terug naar choose).
$('imgSnapBtn').onclick = async () => {
  if (imageViewMode === 'edit') {
    // Afbreken: abort bewerking → terug naar stap 1.
    webcamOff()
    setImageViewMode('choose')
    return
  }
  if (webcamStream) {
    // SNAP: neem frame → canvas → stap 2 (edit).
    const v = $('webcamVideo'), c = $('imgCanvas'), x = c.getContext('2d')
    if (v.videoWidth) {
      const r = Math.max(c.width / v.videoWidth, c.height / v.videoHeight)
      const dw = v.videoWidth * r, dh = v.videoHeight * r
      x.drawImage(v, (c.width - dw) / 2, (c.height - dh) / 2, dw, dh)
    } else { x.drawImage(v, 0, 0, c.width, c.height) }
    try {
      const px = x.getImageData((c.width / 2) | 0, (c.height / 2) | 0, 1, 1).data
      if (px[3] === 0 || (px[0] + px[1] + px[2] < 30)) {
        $('imgInstr').textContent = 'camera nog niet gereed — wacht op beeld en probeer opnieuw'
        return  // laat stream draaien, geen webcamOff
      }
    } catch { /* tainted canvas zeldzaam bij getUserMedia; neem genoegen met draw */ }
    webcamOff()
    // Snap levert een frame op canvas; maak een Image van de canvas-data om initIE te voeden (zodat tools werken).
    const snapImg = new Image()
    snapImg.onload = () => { initIE(snapImg); ieRedraw(); setImageViewMode('edit') }
    snapImg.src = c.toDataURL('image/png')
  } else {
    // Klik: camera aan → label 'Opname'.
    try {
      webcamStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } })
      const v = $('webcamVideo'); v.muted = true; v.srcObject = webcamStream; v.style.display = 'block'; await v.play().catch(() => {})
      $('imgSnapLbl').textContent = t('IMG_CAPTION')  // 'Opname'
    } catch (e) { $('imgInstr').textContent = 'FOUT: ' + e.message }
  }
}
$('navYear').onchange = (e) => { txYear = Number(e.target.value); txSelectedTid = 0; renderTransactions(currentParams).catch(() => {}) }
$('navMonth').onchange = (e) => { txMonth = Number(e.target.value); txSelectedTid = 0; renderTransactions(currentParams).catch(() => {}) }
// ============================ I18N-BOOT + TAALKIEZER ============================
// Eerst het woordenboek laden, dan de statische teksten invullen, de keuzelijst
// bouwen en pas daarna een bewaarde sessie hervatten (zodat de eerste render al de
// juiste taal heeft). Een taalwissel vult de statische teksten opnieuw, herlabelt de
// gevulde keuzelijsten (met behoud van selectie) en hertekent de actieve view.
// --- Taalvlag (rechtsboven) + taalpagina (zoek + vlaggenlijst), als overlay zodat
//     hij zowel uitgelogd (login) als ingelogd werkt — los van de login-router.
function renderLangFlag() { $('langFlag').innerHTML = getFlag(getLang(), 'hdr') }

/** Bouw de vlaggenlijst (één keer per opening): vlag + naam, klik = taal kiezen. */
function buildLangList() {
  const box = $('langListBox'); if (!box) return
  box.innerHTML = ''
  const cur = getLang()
  for (const [code, name] of Object.entries(LANGUAGES)) {
    if (!hasLang(code)) continue
    const item = document.createElement('label')
    item.className = 'lang-item'
    item.dataset.searchname = name.toLowerCase()
    item.innerHTML =
      `<input type="radio" class="lang-radio" name="language_choice" value="${code}" ${code === cur ? 'checked' : ''} />` +
      `<div class="lang-content"><div class="flag-container">${getFlag(code)}</div>` +
      `<span class="lang-text">${name}</span></div>`
    item.addEventListener('click', (e) => { e.preventDefault(); chooseLang(code) })
    box.append(item)
  }
}
function openLangOverlay() {
  buildLangList()
  $('langSearch').value = ''
  $('langOverlay').classList.remove('hidden')
  $('langSearch').focus?.()
}
function closeLangOverlay() { $('langOverlay').classList.add('hidden') }
function chooseLang(code) { setLang(code); closeLangOverlay() }

;(async () => {
  await loadI18n()
  applyStaticI18n()
  populateSelects()
  restoreSignupForm()  // Punt 04-24-07: herstel opgeslagen signup-velden (na populateSelects, zodat selects gevuld zijn)
  renderLangFlag()
  $('langFlag').onclick = openLangOverlay
  $('langCancelBtn').onclick = closeLangOverlay
  $('langSearch').oninput = () => {
    const q = $('langSearch').value.toLowerCase()
    for (const it of $('langListBox').querySelectorAll('.lang-item'))
      it.style.display = (!q || it.dataset.searchname.includes(q)) ? '' : 'none'
  }
  onLangChange(() => {
    applyStaticI18n()
    renderLangFlag()
    relabelSelect('suHair', hairLabels())
    relabelSelect('suLeftEye', eyeLabels())
    relabelSelect('suRightEye', eyeLabels())
    if (profileEditing) {
      relabelSelect('peGender', genderLabels())
      relabelSelect('peHair', hairLabels())
      relabelSelect('peLeftEye', eyeLabels())
      relabelSelect('peRightEye', eyeLabels())
    }
    refreshSignupImagePreview()
    if (me != null && stores) render().catch(() => {})
  })
  tryResume() // bewaarde sessie hervatten na (her)laden
})()
