/**
 * Abundomy browser-SPA. Draait de hele dapp client-side: identiteit, replicatie,
 * saldo, proposals, betalingen en keten-export — herbruikt de portable kern uit
 * `../../src/*`. Connectiviteit via de relay (zie `web/relay.mjs`).
 *
 * Inloggen kan op drie manieren:
 *  - legacy: gemigreerde gebruiker via usersId (seed = `abundomy-user-<id>`)
 *  - seed-login: nieuw account via zijn seed (usersId wordt opgezocht via de pubkey)
 *  - signup: nieuw account aanmaken met e-mailverificatie (`/api/email/*`)
 */
import { multiaddr } from '@multiformats/multiaddr'
import { startBrowserNode } from './ipfs-browser.mjs'
import { openStores, closeStores } from '../../src/stores.mjs'
import { deriveCommunityKey, decryptUserProfile } from '../../src/crypto.mjs'
import { availableCoins, joinedDate, parseSqlDate } from '../../src/ledger.mjs'
import { createProposal, payProposal } from '../../src/payments.mjs'
import { claimUser, signup, changePassword, rekeyAuth, deriveAccountKey, updateProfile } from '../../src/identity.mjs'
import { createKeystore, openKeystore, validatePassword, generateRecoveryCode, formatRecoveryCode, normalizeRecoveryCode } from '../../src/auth.mjs'
import { exportUserChain } from '../../src/export.mjs'
import { addToList, removeFromList, getList, BLACKLIST, WHITELIST } from '../../src/lists.mjs'
import { COMMUNITY_SECRET, DECAY_RATE } from '../../src/config.mjs'
import { t, getLang, setLang, onLangChange, loadI18n, applyStaticI18n, getFlag, hasLang, LANGUAGES } from './i18n.mjs'

const $ = (id) => document.getElementById(id)
const log = (...a) => { $('log').textContent += a.join(' ') + '\n'; $('log').scrollTop = 1e9 }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
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

/** Dial de relay en wacht tot er een pubsub-peer is. Geeft het relay-multiaddr terug. */
async function dialRelay(n) {
  const relay = await (await fetch('relay.json')).json()
  const relayMa = multiaddr(relay.addr)
  await n.ipfs.libp2p.dial(relayMa)
  await waitFor(() => n.ipfs.libp2p.services.pubsub.getPeers().length > 0, 'relay-peer')
  return relayMa
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

  log('Verbinden met relay…')
  const relayMa = await dialRelay(node)
  const pubsub = node.ipfs.libp2p.services.pubsub

  // Houd de relay-verbinding levend (floodsub is fire-and-forget).
  setInterval(async () => {
    if (pubsub.getPeers().length === 0) {
      log('geen pubsub-peer — opnieuw verbinden…')
      try { await node.ipfs.libp2p.dial(relayMa) } catch {}
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
  lp.addEventListener('connection:close', () => log(`- connectie weg (${lp.getConnections().length} over)`))
  setInterval(() => render().catch(() => {}), 2500)
  // Vangnet voor gemiste floodsub-pushes / half-dode relay-connectie: periodiek
  // de verbinding vernieuwen zodat gemiste entries alsnog binnenkomen.
  setInterval(() => resyncStores().catch(() => {}), 20000)

  $('app-header').classList.remove('hidden')
  for (const id of ['login', 'signup', 'resetCard']) $(id).classList.add('hidden')
  $('goDashboard').classList.add('hidden')
  if (!(location.hash || '').startsWith('#/')) location.hash = '#/'
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

/** Legacy: gemigreerde gebruiker via usersId. */
async function connect() {
  $('connectBtn').disabled = true
  try {
    me = Number($('userId').value)
    await ensureSession()
    log('Identiteit binden aan gebruiker (ondertekende claim)…')
    await claimUser({ stores, seed: `abundomy-user-${me}`, usersId: me })
    await finishLogin()
  } catch (err) {
    log('FOUT: ' + err.message)
    $('connectBtn').disabled = false
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
    if (!rec.auth) throw new Error('dit account heeft geen wachtwoord — gebruik de migratie/dev-login')
    await openKeystore(rec.auth, pwd) // verifieert het wachtwoord (gooit 'verkeerd wachtwoord')
    me = rec.usersId
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
    const r = await fetch('/api/email/start', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, pubkey, recoveryCode: formatRecoveryCode(recoveryRaw) }),
    })
    if (r.status === 409) throw new Error('dit e-mailadres is al in gebruik')
    if (!r.ok) throw new Error('verificatie-aanvraag mislukt — probeer het nog eens')
    info('✉ Check je e-mail en klik de bevestigingslink — houd dit tabblad open, ik wacht…')

    await waitFor(async () => {
      const s = await (await fetch('/api/email/status?email=' + encodeURIComponent(email))).json()
      return s.verified && s.pubkey === pubkey
    }, 'e-mailverificatie', 10 * 60 * 1000)

    info('E-mail bevestigd ✓ — wachtwoord-keystore + herstelkluis aanmaken…')
    const auth = await createKeystore(seed, pwd)
    const recovery = await createKeystore(seed, recoveryRaw)
    const doc = await signup({ stores, seed, profile, communityKey, auth, recovery })
    me = doc.usersId
    info(`Account #${me} aangemaakt ✓ — log voortaan in met je gebruikersnaam en wachtwoord. ` +
      `De herstelcode staat in je welkomstmail.`)
    $('goDashboard').classList.remove('hidden')
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
    const relay = await (await fetch('relay.json')).json()
    const relayMa = multiaddr(relay.addr)
    const relayPeer = relayMa.getPeerId()
    log('↻ verbinding vernieuwen…')
    // 1. sluit de (mogelijk half-dode) relay-verbinding(en)
    for (const conn of lp.getConnections()) {
      if (relayPeer && conn.remotePeer.toString() === relayPeer) { try { await conn.close() } catch {} }
    }
    // 2. laat de relay de disconnect verwerken (onze subscriptions opschonen)
    await sleep(1200)
    // 3. verse verbinding
    await lp.dial(relayMa)
    await waitFor(() => lp.services.pubsub.getPeers().length > 0, 'relay-resync', 12000).catch(() => {})
    // 4. her-subscribe elke store op de verse verbinding → relay stuurt z'n heads terug
    for (const db of Object.values(stores)) {
      try { await db.sync.stop(); await db.sync.start() } catch {}
    }
    await sleep(2000) // head-uitwisseling tijd geven
    log(`↻ vernieuwd (pubsub-peers: ${lp.services.pubsub.getPeers().length})`)
  } catch (e) { log('↻ resync-fout: ' + e.message) }
  finally { resyncing = false }
  await render().catch(() => {})
}

// ============================ NAVIGATIE (hash-router) ============================
// De SPA toont één <section class="view"> tegelijk. route() leest location.hash,
// toont de juiste view en laat de dispatcher render() die view (her)tekenen.
let currentView = 'home'
let currentParams = {}

const VIEW_NAMES = { '': 'home', home: 'home', transactions: 'transactions', tx: 'txdetail', profile: 'profile' }

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
  for (const v of ['home', 'transactions', 'txdetail', 'profile']) {
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

  // 'Van'-keuzelijst van het aanvraagformulier (alle andere gebruikers).
  const sel = $('fromUser')
  if (sel.options.length !== users.length - 1) {
    sel.innerHTML = ''
    for (const u of users.filter((u) => u.usersId !== me)) {
      const o = document.createElement('option'); o.value = u.usersId
      o.textContent = `${u.usersName || '#' + u.usersId} (#${u.usersId})`; sel.append(o)
    }
  }

  // Partnerprofielen ontsleutelen (voor avatar + naam-fallback).
  const partnerIds = new Set([...myRequests.map((p) => p.giver), ...toPay.map((p) => p.receiver)])
  const partner = new Map()
  for (const id of partnerIds) {
    const doc = profilesById.get(id)
    partner.set(id, doc ? await safeProfile(doc) : { usersId: id, usersName: `#${id}` })
  }

  // MIJN VERZOEKEN
  const mr = $('myRequests'); mr.innerHTML = ''
  $('noRequestsRow').classList.toggle('hidden', myRequests.length > 0)
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
  if (!monthTxs.some((t) => t.tid === txSelectedTid)) txSelectedTid = monthTxs.length ? monthTxs[0].tid : 0

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
  const t = monthTxs.find((x) => x.tid === txSelectedTid)
  if (!t) return
  const isGiver = t.giver === uid
  const st = previousTransactionState(all, uid, t.time_stamp, joined)
  const newBalance = st.availableBalance + (isGiver ? -t.amount : t.amount)
  const partnerId = isGiver ? t.receiver : t.giver
  const partnerDoc = users.find((u) => u.usersId === partnerId)
  const color = isGiver ? 'var(--error)' : '#00BFFF'
  const sign = isGiver ? '-' : '+'
  const desc = (t.description || '').slice(0, 25)

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
        `<span class="calc-val" style="color:${color}; flex-shrink:0; text-align:right;">${sign}${formatCoins(t.amount)} ᕫ</span>` +
      `</div>` +
    `</a>` +
    `<div class="full-screen-line"></div>` +
    calcRow('<strong>Nieuw saldo</strong>', `<strong>${formatCoins(newBalance)} ᕫ</strong>`) +
    `<div class="full-screen-line"></div>`
  const link = $('calcDetailLink'); if (link) link.href = `#/tx/${t.tid}`
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

async function renderProfile({ id } = {}) {
  if (profileEditing) return // niet herrenderen tijdens bewerken (zou velden overschrijven)
  const uid = id != null ? Number(id) : me
  const isMe = uid === me
  $('profEditActions').style.display = isMe ? 'flex' : 'none'
  $('profView').classList.remove('hidden')
  $('profEdit').classList.add('hidden')
  let p
  if (isMe) p = myProfile
  else {
    const doc = (await stores.users.get(uid))?.value
    if (!doc) { $('profName').textContent = 'Onbekende gebruiker'; $('profFields').innerHTML = ''; return }
    p = await safeProfile(doc)
  }

  const txs = (await stores.transactions.all()).map((e) => e.value)
  const usersOld = (await stores.usersOld.all()).map((e) => e.value)
  const myDoc = (await stores.users.get(uid))?.value
  const bal = availableCoins({ joined: joinedDate(myDoc ?? { usersId: uid, start: txs[0]?.time_stamp }, usersOld), transactions: txs, userId: uid, asOf: new Date() })

  $('profImg').src = avatarFor({ ...p, usersId: uid })
  $('profName').textContent = p.usersName || `#${uid}`
  $('profBalance').textContent = `${formatCoins(bal)} ᕫ`
  $('profBalanceLink').href = isMe ? '#/transactions' : `#/transactions/${uid}` // saldo → keten (humandetails)

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
  if (isMe) html += calcRow(t('SU_EM'), p.usersEmail || '—') // alleen op eigen profiel
  $('profFields').innerHTML = html

  await renderListControls(uid, isMe) // blok-/whitelijst-knoppen
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
    const r = await fetch('/api/email/start', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: newEmail, pubkey, usersId: me }),
    })
    if (r.status === 409) throw new Error('dit e-mailadres is al in gebruik')
    if (!r.ok) throw new Error('verificatie-aanvraag mislukt — probeer het nog eens')
    info('✉ Check je nieuwe mailbox en klik de bevestigingslink — houd dit tabblad open, ik wacht…')

    await waitFor(async () => {
      const s = await (await fetch('/api/email/status?email=' + encodeURIComponent(newEmail))).json()
      return s.verified && s.pubkey === pubkey
    }, 'e-mailverificatie', 10 * 60 * 1000)

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
  const btn = $('profSaveBtn'); btn.disabled = true
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

async function requestPayment() {
  const giver = Number($('fromUser').value)
  const amount = Number($('amount').value)
  const description = $('desc').value || 'verzoek'
  log(`Verzoek: #${giver} → jou, ${amount} munten…`)
  const giverDoc = (await stores.users.get(giver))?.value
  const receiverDoc = (await stores.users.get(me))?.value
  const p = await createProposal({ stores, giver, receiver: me, amount, description, giverDoc, receiverDoc, asOf: new Date() })
  log(`Verzoek verstuurd (pid ${p.pid}). Wacht op bevestiging door #${giver}.`)
  $('amount').value = ''
  $('desc').value = ''
  $('requestCard').classList.add('hidden') // formulier weer dicht
  await render()
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

/**
 * PDF-maandoverzicht (transactions.php → download-pdf.php). Serverloos: we openen
 * een printvriendelijk venster met het overzicht van de getoonde gebruiker/maand;
 * de browser maakt er via 'Opslaan als PDF' een echte PDF van.
 */
async function printStatement() {
  // Venster METEEN openen (binnen het klik-gebaar) — anders blokkeert de pop-upfilter
  // het na de async data-ophaal. Daarna vullen we het.
  const w = window.open('', '_blank')
  if (!w) { log('Pop-up geblokkeerd — sta pop-ups toe om de PDF te maken.'); return }
  w.document.write('<!doctype html><meta charset="utf-8"><title>Overzicht</title>' +
    '<body style="font:14px Arial,sans-serif;margin:32px;color:#555">Overzicht voorbereiden…</body>')

  const uid = txUserId ?? me
  if (txYear == null) { w.document.body.textContent = 'Open eerst een maand in Transacties.'; return }
  const all = await userTransactions(uid)
  const users = (await stores.users.all()).map((e) => e.value)
  const usersOld = (await stores.usersOld.all()).map((e) => e.value)
  const joined = joinedDate(users.find((u) => u.usersId === uid) ?? { usersId: uid, start: all[0]?.time_stamp }, usersOld)
  const monthTxs = all.filter((t) => { const d = parseSqlDate(t.time_stamp); return d.getUTCFullYear() === txYear && d.getUTCMonth() + 1 === txMonth })
  const name = $('txViewName').textContent || `#${uid}`

  const rows = monthTxs.map((t) => {
    const isGiver = t.giver === uid
    const st = previousTransactionState(all, uid, t.time_stamp, joined)
    const bal = st.availableBalance + (isGiver ? -t.amount : t.amount)
    const color = isGiver ? '#b00000' : '#0070b0'
    const sign = isGiver ? '−' : '+'
    return `<tr><td>${fmtRowDate(t.time_stamp)}</td>` +
      `<td style="text-align:right;color:${color}">${sign}${formatCoins(t.amount)}</td>` +
      `<td style="text-align:right">${formatCoins(bal)}</td></tr>`
  }).join('')

  const period = `${monthsLong()[txMonth - 1]} ${txYear}`
  const html = `<!doctype html><html lang="nl"><head><meta charset="utf-8" />` +
    `<title>Abundomy overzicht ${name} ${period}</title><style>` +
    `body{font-family:Arial,Helvetica,sans-serif;color:#111;margin:32px;}` +
    `h1{font-size:20px;margin:0 0 2px;color:#916B01;}h2{font-size:14px;font-weight:normal;margin:0 0 18px;color:#444;}` +
    `table{width:100%;border-collapse:collapse;font-size:13px;}` +
    `th,td{padding:6px 8px;border-bottom:1px solid #ddd;}th{text-align:left;border-bottom:2px solid #888;}` +
    `th:nth-child(2),th:nth-child(3){text-align:right;}` +
    `.empty{color:#888;font-style:italic;margin-top:12px;}` +
    `@media print{body{margin:12mm;}}</style></head><body>` +
    `<h1>${t('TITLE')} — ${t('PDF_TRANSACTION_OVERVIEW')}</h1>` +
    `<h2>${name} · ${period} · ᕫ</h2>` +
    (monthTxs.length
      ? `<table><thead><tr><th>${t('TR_DATE')}</th><th>${t('TR_AMOUNT')}</th><th>${t('PDF_BALANCE')}</th></tr></thead><tbody>${rows}</tbody></table>`
      : `<p class="empty">${t('APP_NONE_THIS_MONTH')}</p>`) +
    `</body></html>`

  w.document.open(); w.document.write(html); w.document.close(); w.focus()
  setTimeout(() => { try { w.print() } catch {} }, 350) // even tijd om te renderen
  log(`PDF-overzicht ${period} geopend (kies 'Opslaan als PDF').`)
}

fetch('relay.json').then((r) => r.ok ? $('relayInfo').textContent = 'Relay gevonden ✓ — klaar om te verbinden.'
  : $('relayInfo').textContent = '⚠ Geen relay.json — draai eerst `npm run relay`.')
  .catch(() => $('relayInfo').textContent = '⚠ Geen relay.json — draai eerst `npm run relay`.')

$('loginBtn').onclick = () => loginWithPassword().catch((e) => log('FOUT: ' + e.message))
$('connectBtn').onclick = connect
$('signupBtn').onclick = () => doSignup().catch((e) => log('FOUT: ' + e.message))
const showCard = (id) => { for (const c of ['login', 'signup', 'resetCard']) $(c).classList.toggle('hidden', c !== id) }
$('toSignupBtn').onclick = () => showCard('signup')
$('toResetBtn').onclick = () => showCard('resetCard')
$('resetBackBtn').onclick = () => showCard('login')
$('toLogin').onclick = (e) => { e.preventDefault(); showCard('login') }
$('resetBtn').onclick = () => doReset().catch((e) => log('FOUT: ' + e.message))
$('logoutBtn').onclick = () => logout().catch((e) => log('FOUT: ' + e.message))
$('requestBtn').onclick = () => requestPayment().catch((e) => log('FOUT: ' + e.message))
const openRequestForm = () => { $('requestCard').classList.remove('hidden'); $('amount').focus?.() }
$('newRequestBtn').onclick = openRequestForm
$('newRequestBtn2').onclick = openRequestForm
$('requestCancelBtn').onclick = () => $('requestCard').classList.add('hidden')
$('exportBtn').onclick = () => exportChain().catch((e) => log('FOUT: ' + e.message))
$('txPdfBtn').onclick = () => printStatement().catch((e) => log('FOUT: ' + e.message))
$('txCsvBtn').onclick = () => exportChain(txUserId ?? me).catch((e) => log('FOUT: ' + e.message))
$('refreshBtn').onclick = () => { log('Verversen (verse sync)…'); location.reload() }
$('changePwdBtn').onclick = () => doChangePassword().catch((e) => log('FOUT: ' + e.message))
$('goDashboard').onclick = () => finishLogin().catch((e) => log('FOUT: ' + e.message))
window.addEventListener('hashchange', () => route())
$('profEditBtn').onclick = () => enterProfileEdit()
$('profCancelBtn').onclick = () => cancelProfileEdit()
$('profSaveBtn').onclick = () => saveProfile().catch((e) => log('FOUT: ' + e.message))
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
  $('suImgPreview').src = avatarFor({ usersId: 0, usersName: $('suName').value, image: signupImage })
  $('suImgClear').style.display = (typeof signupImage === 'string' && signupImage.startsWith('data:image')) ? 'inline-block' : 'none'
}
$('suImgFile').onchange = async (e) => {
  const file = e.target.files?.[0]; if (!file) return
  try { signupImage = await fileToAvatarDataURL(file); refreshSignupImagePreview() }
  catch (err) { $('signupInfo').textContent = 'FOUT: ' + err.message }
  e.target.value = ''
}
$('suImgClear').onclick = () => { signupImage = ''; refreshSignupImagePreview() }
$('suName').addEventListener('input', () => { if (!signupImage) refreshSignupImagePreview() })
refreshSignupImagePreview()
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
