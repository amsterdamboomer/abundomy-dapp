/**
 * mailer.mjs — relay-side mail-/verificatie-service voor de IPFS-omgeving.
 *
 * Draait als losse service NAAST de relay (op SER5). Verbindt als client met de relay,
 * repliceert de OrbitDB-stores, en biedt:
 *   Fase 1 — transactie-notificaties: bij een NIEUWE transactie mail naar gever/ontvanger
 *            (mits hun `paymentEmails` aanstaat). Beide partijen, zoals de oude 1coinh-site.
 *   Fase 2 — e-mailverificatie + uniciteit: een HTTP-endpoint dat bij signup een token mailt
 *            en bij bevestiging een e-mail↔pubkey-binding vastlegt (één e-mail = één account).
 *
 * Verstuurt via authenticated SMTP-submission naar mail.reikiwereld.eu (poort 25 op SER5 is
 * dicht; 587/465 open). Heeft de community-sleutel om e-mailadressen te ontsleutelen.
 *
 * Config via env (zie web/mailer.env.example):
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM, SMTP_TLS_INSECURE
 *   MAIL_REDIRECT_TO        (test: stuur alle notificaties naar dit adres)
 *   MAILER_HTTP_PORT        (default 9100, alleen 127.0.0.1 — nginx proxiet /api/ hierheen)
 *   ABUNDOMY_PUBLIC_BASE    (default https://app.reikiwereld.eu — voor de bevestig-link)
 *   ABUNDOMY_RELAY_ADDR     (default uit relay.json; op SER5 liever de lokale ws-addr)
 * Zonder SMTP_* draait hij in DRY-RUN (logt wat hij zou sturen).
 *
 * Gebruik:
 *   node web/mailer.mjs                         # de service (notificaties + verificatie-HTTP)
 *   node web/mailer.mjs --env <pad>             # env uit een bestand laden
 *   node web/mailer.mjs --test-mail <adres>     # stuur één testmail en stop (SMTP-check)
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { webSockets } from '@libp2p/websockets'
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2'
import { identify } from '@libp2p/identify'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { floodsub } from '@libp2p/floodsub'
import { generateKeyPairFromSeed } from '@libp2p/crypto/keys'
import { multiaddr } from '@multiformats/multiaddr'
import { createHelia } from 'helia'
import { FsBlockstore } from 'blockstore-fs'
import { FsDatastore } from 'datastore-fs'
import { createOrbitDB, Documents, IPFSAccessController } from '@orbitdb/core'
import nodemailer from 'nodemailer'
import { openStores } from '../src/stores.mjs'
import { deriveCommunityKey, decryptUserProfile } from '../src/crypto.mjs'
import { COMMUNITY_SECRET } from '../src/config.mjs'

// Optioneel env-bestand laden met `--env <pad>` (robuuste KEY=VALUE-parser; geen shell-
// quoting nodig, dus spaties/rare tekens in waarden geven geen problemen).
{
  const i = process.argv.indexOf('--env')
  if (i !== -1 && process.argv[i + 1]) {
    for (const line of readFileSync(process.argv[i + 1], 'utf8').split('\n')) {
      if (/^\s*#/.test(line) || !line.includes('=')) continue
      const k = line.slice(0, line.indexOf('=')).trim()
      const v = line.slice(line.indexOf('=') + 1).trim()
      if (k) process.env[k] ??= v
    }
  }
}

const ROOT = process.env.ABUNDOMY_MAILER_ROOT
  ? process.env.ABUNDOMY_MAILER_ROOT.replace(/\/?$/, '/')
  : fileURLToPath(new URL('../.abundomy-mailer/', import.meta.url))
const RELAY_JSON = fileURLToPath(new URL('./public/relay.json', import.meta.url))
const APP_URL = process.env.ABUNDOMY_APP_URL || 'https://app.reikiwereld.eu/app/'
const PUBLIC_BASE = (process.env.ABUNDOMY_PUBLIC_BASE || 'https://app.reikiwereld.eu').replace(/\/$/, '')
const HTTP_PORT = Number(process.env.MAILER_HTTP_PORT) || 9100

const SMTP_HOST = process.env.SMTP_HOST
const SMTP_PORT = Number(process.env.SMTP_PORT) || 587
const SMTP_USER = process.env.SMTP_USER
const SMTP_PASS = process.env.SMTP_PASS
const MAIL_FROM_RAW = process.env.MAIL_FROM || 'noreply@reikiwereld.eu'
// Display-naam toevoegen als alleen een adres is opgegeven (voorkomt quoting-gedoe in env).
const MAIL_FROM = MAIL_FROM_RAW.includes('<') ? MAIL_FROM_RAW : `Abundomy Money <${MAIL_FROM_RAW}>`
// Noodklep voor een verlopen/onjuist mailserver-cert: SMTP_TLS_INSECURE=1 → cert niet valideren.
const TLS_INSECURE = process.env.SMTP_TLS_INSECURE === '1'
// Test-vangnet: als gezet, gaan ALLE transactie-notificaties naar dit adres i.p.v. de echte user.
const REDIRECT = process.env.MAIL_REDIRECT_TO || ''
const DRY = !(SMTP_HOST && SMTP_USER && SMTP_PASS)

const esc = (s) => String(s ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const emailHashOf = (email) => createHash('sha256').update(String(email).trim().toLowerCase()).digest('hex')
async function waitFor (fn, label, timeout = 60000) {
  const t = Date.now()
  while (Date.now() - t < timeout) { if (await fn()) return; await sleep(500) }
  throw new Error('timeout: ' + label)
}

function makeTransport () {
  if (DRY) return null
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465, // 465 = impliciet TLS, 587 = STARTTLS
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    ...(TLS_INSECURE ? { tls: { rejectUnauthorized: false } } : {}),
  })
}

/** Bouw de notificatie-mail voor één transactie. */
function paymentMail (tx, giver, receiver) {
  const amount = Number(tx.amount).toFixed(2)
  return {
    subject: `Abundomy — betaling van ${amount} ᕫ verwerkt`,
    html: `<html><body style="font-family:sans-serif">
      <p>Er is een betaling van <b>${amount} ᕫ</b> verwerkt in Abundomy.</p>
      <p><b>Van:</b> ${esc(giver?.name)}<br>
         <b>Naar:</b> ${esc(receiver?.name)}</p>
      <p><b>Omschrijving:</b> ${esc(tx.description || '—')}</p>
      <p><a href="${APP_URL}">Open de Abundomy-app</a></p>
      <hr><p style="color:#888;font-size:12px">Je ontvangt deze mail omdat betaalnotificaties
      aanstaan in je profiel. Pas dit aan in de app.</p>
      </body></html>`,
  }
}

/** Bouw de notificatie-mail voor een openstaand verzoek (proposal) — naar de gever. */
function proposalMail (p, giver, receiver) {
  const amount = Number(p.amount).toFixed(2)
  return {
    subject: `Abundomy — openstaand verzoek van ${amount} ᕫ`,
    html: `<html><body style="font-family:sans-serif">
      <p><b>${esc(receiver?.name)}</b> vraagt <b>${amount} ᕫ</b> van je in Abundomy.</p>
      <p><b>Omschrijving:</b> ${esc(p.description || '—')}</p>
      <p>Open de app om dit verzoek te <b>bevestigen</b> of te weigeren:</p>
      <p><a href="${APP_URL}">Open de Abundomy-app</a></p>
      <hr><p style="color:#888;font-size:12px">Je ontvangt deze mail omdat betaalnotificaties
      aanstaan in je profiel. Pas dit aan in de app.</p>
      </body></html>`,
  }
}

// --- testmodus: stuur één mail en stop -------------------------------------
const testIdx = process.argv.indexOf('--test-mail')
if (testIdx !== -1) {
  const to = process.argv[testIdx + 1]
  if (!to) { console.error('gebruik: node web/mailer.mjs --test-mail <adres>'); process.exit(1) }
  if (DRY) { console.error('✗ SMTP niet geconfigureerd (SMTP_HOST/USER/PASS) — kan geen testmail sturen'); process.exit(1) }
  const t = makeTransport()
  await t.verify()
  console.log(`✓ SMTP-verbinding OK (${SMTP_HOST}:${SMTP_PORT})`)
  await t.sendMail({
    from: MAIL_FROM,
    to,
    subject: 'Abundomy — testmail (mailer)',
    html: '<p>Dit is een testmail van de Abundomy IPFS-mailer. Als je dit ziet, werkt SMTP-submission via mail.reikiwereld.eu. ✅</p>',
  })
  console.log(`✉ testmail verstuurd naar ${to}`)
  process.exit(0)
}

// --- service: libp2p + Helia + OrbitDB --------------------------------------
const relay = JSON.parse(readFileSync(RELAY_JSON, 'utf8'))
const privateKey = await generateKeyPairFromSeed('Ed25519', createHash('sha256').update('abundomy-mailer').digest())
const libp2p = await createLibp2p({
  privateKey,
  addresses: { listen: [] }, // client: luistert niet, dialt alleen de relay
  transports: [tcp(), webSockets(), circuitRelayTransport()],
  connectionEncrypters: [noise()],
  streamMuxers: [yamux()],
  connectionGater: { denyDialMultiaddr: () => false },
  services: { identify: identify(), pubsub: floodsub({ emitSelf: true }) },
})
const ipfs = await createHelia({ libp2p, blockstore: new FsBlockstore(`${ROOT}blocks`), datastore: new FsDatastore(`${ROOT}data`) })
const orbitdb = await createOrbitDB({ ipfs, id: 'abundomy-mailer', directory: `${ROOT}orbitdb` })

// Beheermodus: verwijder een e-mailbinding uit de lokale store en stop (draai met de
// service GESTOPT, zodat de default data-dir vrij is). Gebruik: --del-email <adres>
const delIdx = process.argv.indexOf('--del-email')
if (delIdx !== -1) {
  const emails = process.argv.slice(delIdx + 1).filter((a) => a && !a.startsWith('--'))
  if (!emails.length) { console.error('gebruik (met de service GESTOPT): node web/mailer.mjs --del-email <adres> [<adres>…]'); process.exit(1) }
  // Werkt op de lokale (authoritatieve) store — draai dit met de service GESTOPT.
  const v = await orbitdb.open('abundomy-email-verifications', {
    sync: true, Database: Documents({ indexBy: 'emailHash' }), AccessController: IPFSAccessController({ write: ['*'] }),
  })
  for (const email of emails) {
    const eh = emailHashOf(email)
    if ((await v.get(eh))?.value) { await v.del(eh); console.log(`✓ binding verwijderd: ${email}`) }
    else console.log(`(geen binding gevonden voor ${email})`)
  }
  try { await orbitdb.stop() } catch {}
  try { await ipfs.stop() } catch {}
  process.exit(0)
}

// Op SER5 draait de mailer naast de relay: dial bij voorkeur lokaal (vermijdt NAT-hairpin).
const RELAY_ADDR = process.env.ABUNDOMY_RELAY_ADDR || relay.addr
console.log(`• verbinden met relay: ${RELAY_ADDR}`)
await libp2p.dial(multiaddr(RELAY_ADDR))
const stores = await openStores(orbitdb, { addresses: relay.stores })
const communityKey = await deriveCommunityKey(COMMUNITY_SECRET)
const transport = makeTransport()

if (DRY) console.log('⚠ SMTP niet geconfigureerd → DRY-RUN (mails worden gelogd, niet verstuurd)')
else { await transport.verify(); console.log(`✓ SMTP-verbinding OK (${SMTP_HOST}:${SMTP_PORT}), afzender ${MAIL_FROM}`) }

// Verstuur met één retry (de eerste poging faalt soms op een trage/koude SMTP-verbinding).
async function sendWithRetry (opts, tries = 2) {
  let last
  for (let i = 0; i < tries; i++) {
    try { return await transport.sendMail(opts) } catch (e) { last = e; await sleep(1500) }
  }
  throw last
}

// Profiel + mailvoorkeur van een gebruiker (ontsleuteld).
async function userInfo (id) {
  const doc = (await stores.users.get(id))?.value
  if (!doc) return null
  const p = await decryptUserProfile(doc, communityKey)
  return { name: p.usersName, email: p.usersEmail, paymentEmails: Number(p.paymentEmails) === 1 }
}

async function allTxs () { return (await stores.transactions.all()).map((e) => e.value) }

// =========================================================================
// Fase 1 — transactie-notificaties
// =========================================================================
await waitFor(async () => (await allTxs()).length > 0, 'transactie-sync').catch(() => {})
const seen = new Set((await allTxs()).map((t) => t.tid))
console.log(`• baseline: ${seen.size} bestaande transacties (worden NIET gemaild)`)

async function notify (tx) {
  const giver = await userInfo(tx.giver)
  const receiver = await userInfo(tx.receiver)
  const { subject, html } = paymentMail(tx, giver, receiver)
  for (const r of [giver, receiver]) {
    if (!r?.email || !r.paymentEmails) continue
    const to = REDIRECT || r.email
    if (DRY) { console.log(`[DRY] → ${to}${REDIRECT ? ` (i.p.v. ${r.email})` : ''} | ${subject}`); continue }
    const body = REDIRECT ? `<p style="color:#b00">[TEST — eigenlijk bedoeld voor ${esc(r.email)}]</p>${html}` : html
    try {
      await sendWithRetry({ from: MAIL_FROM, to, subject, html: body })
      console.log(`✉ verstuurd → ${to} (tx ${tx.tid})`)
    } catch (e) { console.error(`✗ mail mislukt → ${to}: ${e.message}`) }
  }
}

stores.transactions.events.on('update', async () => {
  try {
    for (const tx of await allTxs()) {
      if (seen.has(tx.tid)) continue
      seen.add(tx.tid)
      console.log(`• nieuwe transactie tid=${tx.tid} (${tx.giver}→${tx.receiver}, ${tx.amount})`)
      await notify(tx)
    }
  } catch (e) { console.error('mail-handler fout:', e.message) }
})

// --- openstaande verzoeken (proposals): mail de GEVER zodra er een nieuw verzoek staat ---
// Composiet-sleutel i.p.v. pid alleen: pid's worden hergebruikt nadat een verzoek is
// betaald/verwijderd (pid = max+1 reset bij een lege store).
const pkey = (p) => `${p.pid}:${p.giver}:${p.receiver}:${p.amount}:${p.description ?? ''}`
async function allProposals () { return (await stores.proposals.all()).map((e) => e.value) }
const seenProposals = new Set((await allProposals()).map(pkey))
console.log(`• baseline: ${seenProposals.size} bestaande proposals (worden NIET gemaild)`)

async function notifyProposal (p) {
  const giver = await userInfo(p.giver)
  const receiver = await userInfo(p.receiver)
  if (!giver?.email || !giver.paymentEmails) return
  const { subject, html } = proposalMail(p, giver, receiver)
  const to = REDIRECT || giver.email
  if (DRY) { console.log(`[DRY] → ${to}${REDIRECT ? ` (i.p.v. ${giver.email})` : ''} | ${subject}`); return }
  const body = REDIRECT ? `<p style="color:#b00">[TEST — eigenlijk bedoeld voor ${esc(giver.email)}]</p>${html}` : html
  try {
    await sendWithRetry({ from: MAIL_FROM, to, subject, html: body })
    console.log(`✉ verstuurd → ${to} (proposal ${p.pid})`)
  } catch (e) { console.error(`✗ mail mislukt → ${to}: ${e.message}`) }
}

stores.proposals.events.on('update', async () => {
  try {
    for (const p of await allProposals()) {
      const k = pkey(p)
      if (seenProposals.has(k)) continue
      seenProposals.add(k)
      console.log(`• nieuw verzoek pid=${p.pid} (${p.receiver} vraagt ${p.amount} van ${p.giver})`)
      await notifyProposal(p)
    }
  } catch (e) { console.error('proposal-handler fout:', e.message) }
})

// =========================================================================
// Fase 2 — e-mailverificatie + uniciteit (HTTP, achter nginx /api/)
// =========================================================================
// Authoritatieve binding-store: emailHash → { pubkey, usersId, verifiedAt }.
// De mailer is de verifier; hij schrijft pas een binding ná bewijs van e-mailbezit (token).
const verifications = await orbitdb.open('abundomy-email-verifications', {
  sync: true,
  Database: Documents({ indexBy: 'emailHash' }),
  AccessController: IPFSAccessController({ write: ['*'] }),
})
const pending = new Map() // token → { emailHash, email, pubkey, usersId, exp }
const TOKEN_TTL = 30 * 60 * 1000

// Gedeelde download-teller (vervangt de oude MySQL `downloads`-tabel). Per taalcode één
// doc { _id: lang, count }. De mailer is de enige schrijver — alle /api/downloads-POSTs
// lopen hierlangs — dus serialiseren we read-modify-write in-proces (geen verloren tellen).
const downloads = await orbitdb.open('abundomy-downloads', {
  sync: true,
  Database: Documents({ indexBy: '_id' }),
  AccessController: IPFSAccessController({ write: ['*'] }),
})
const DL_LANGS = new Set(('ah ar am az by be bo bg ca ch cz se da de en es fp fr ir gr ha he hi cr ig in ' +
  'ic it ja ka kh ki sh co ko kg la lv lt hu mg ma ml mo bu ne np no or pa pe po pt ro ru zi al sl sk ' +
  'so fi sw ta th vi tu ur yo').split(' '))
// Niet-taal-items met een eigen teller (bv. de OneCoinH-demo op de artikelpagina's). Ze
// staan los van het boek: `total` telt ALLEEN de taalcodes (boek-downloads), niet deze.
const DL_ITEMS = new Set(['xlsx'])
async function downloadCounts () {
  const counts = {}; let total = 0
  for (const r of await downloads.all()) {
    const n = Number(r.value.count) || 0; counts[r.value._id] = n
    if (DL_LANGS.has(r.value._id)) total += n // boek-totaal = som van taalcodes
  }
  return { counts, total }
}
let dlQueue = Promise.resolve()
function bumpDownload (lang) {
  dlQueue = dlQueue.then(async () => {
    const count = (Number((await downloads.get(lang))?.value?.count) || 0) + 1
    await downloads.put({ _id: lang, count })
  }).catch((e) => console.error('downloads-bump:', e.message))
  return dlQueue
}

async function bindingFor (emailHash) { return (await verifications.get(emailHash))?.value ?? null }

async function sendVerificationMail (email, token, recoveryCode) {
  const link = `${PUBLIC_BASE}/api/email/confirm?token=${token}`
  const recoveryBlock = recoveryCode ? `
    <hr><p><b>Je herstelcode</b> — bewaar deze mail goed. Hiermee kun je (samen met dit
    e-mailadres) je wachtwoord resetten als je het kwijtraakt:</p>
    <p style="font-family:monospace;font-size:18px;letter-spacing:2px;background:#f4f4f4;padding:10px 14px;border-radius:8px;display:inline-block">${esc(recoveryCode)}</p>
    <p style="color:#888;font-size:12px">Zonder deze code én dit e-mailadres is je account niet te herstellen.</p>` : ''
  const html = `<html><body style="font-family:sans-serif">
    <p>Welkom bij Abundomy! Bevestig je e-mailadres om je account te activeren:</p>
    <p><a href="${esc(link)}">Bevestig mijn e-mailadres</a></p>
    <p style="color:#888;font-size:12px">Deze link is 30 minuten geldig. Niet aangevraagd? Negeer deze mail.</p>
    ${recoveryBlock}
    </body></html>`
  if (DRY) { console.log(`[DRY] verificatie → ${email}: ${link}${recoveryCode ? ` | herstelcode: ${recoveryCode}` : ''}`); return }
  await sendWithRetry({ from: MAIL_FROM, to: email, subject: 'Bevestig je e-mailadres voor Abundomy', html })
}

const sendJson = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)) }
const sendHtml = (res, code, body) => { res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' }); res.end(body) }

const httpServer = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost')

    // Start verificatie: { email, pubkey, usersId? } → token mailen (uniciteit afgedwongen).
    if (req.method === 'POST' && url.pathname === '/api/email/start') {
      let raw = ''
      for await (const c of req) raw += c
      const { email, pubkey, usersId, recoveryCode } = JSON.parse(raw || '{}')
      if (!email || !pubkey) return sendJson(res, 400, { error: 'email en pubkey vereist' })
      const emailHash = emailHashOf(email)
      const existing = await bindingFor(emailHash)
      if (existing && existing.pubkey !== pubkey) return sendJson(res, 409, { error: 'e-mailadres is al in gebruik' })
      const token = randomBytes(24).toString('hex')
      pending.set(token, { emailHash, email, pubkey, usersId: usersId ?? null, exp: Date.now() + TOKEN_TTL })
      await sendVerificationMail(email, token, recoveryCode)
      console.log(`• verificatie aangevraagd: ${email} (pubkey ${String(pubkey).slice(0, 12)}…)`)
      return sendJson(res, 200, { ok: true })
    }

    // Bevestig verificatie via de gemailde link → binding vastleggen.
    if (req.method === 'GET' && url.pathname === '/api/email/confirm') {
      const token = url.searchParams.get('token')
      const p = token && pending.get(token)
      if (!p || p.exp < Date.now()) { if (p) pending.delete(token); return sendHtml(res, 400, '<h1>Link ongeldig of verlopen</h1>') }
      pending.delete(token)
      await verifications.put({ emailHash: p.emailHash, pubkey: p.pubkey, usersId: p.usersId, verifiedAt: new Date().toISOString() })
      console.log(`✓ e-mail geverifieerd: ${p.email} ↔ ${String(p.pubkey).slice(0, 12)}…`)
      return sendHtml(res, 200, `<html><body style="font-family:sans-serif;text-align:center;margin-top:60px;line-height:1.6">
        <h1>E-mail bevestigd ✅</h1>
        <p><b>Ga nu terug naar het tabblad waar je je aanmelding startte.</b><br>
        Dat scherm rondt automatisch af en maakt je account aan met je gekozen wachtwoord.</p>
        <p style="color:#888;font-size:13px">Bewaar de <b>herstelcode</b> uit je welkomstmail — daarmee reset je je
        wachtwoord als je het kwijtraakt. Tabblad gesloten? Start de aanmelding gewoon opnieuw.</p>
        </body></html>`)
    }

    // Status opvragen (de SPA kan checken of een e-mail/pubkey geverifieerd is).
    if (req.method === 'GET' && url.pathname === '/api/email/status') {
      const email = url.searchParams.get('email')
      const emailHash = url.searchParams.get('emailHash') || (email ? emailHashOf(email) : null)
      const b = emailHash ? await bindingFor(emailHash) : null
      return sendJson(res, 200, { verified: !!b, pubkey: b?.pubkey ?? null, usersId: b?.usersId ?? null })
    }

    // Download-teller: huidige stand opvragen.
    if (req.method === 'GET' && url.pathname === '/api/downloads') {
      return sendJson(res, 200, await downloadCounts())
    }
    // Download-teller: ophogen voor een taalcode (alle clients POSTen hier → één schrijver).
    if (req.method === 'POST' && url.pathname === '/api/downloads') {
      let raw = ''
      for await (const c of req) raw += c
      let lang = ''
      try { lang = String(JSON.parse(raw || '{}').lang || '').toLowerCase().replace(/[^a-z]/g, '').slice(0, 4) } catch {}
      if (!DL_LANGS.has(lang) && !DL_ITEMS.has(lang)) return sendJson(res, 400, { error: 'onbekende sleutel' })
      await bumpDownload(lang)
      return sendJson(res, 200, await downloadCounts())
    }

    if (url.pathname === '/api/health') return sendJson(res, 200, { ok: true })

    // Lokaal beheer-endpoint: verwijder een binding. NIET via nginx geproxyd (nginx routeert
    // alleen /api/), dus alleen bereikbaar op 127.0.0.1. Extra guard: weiger als geproxyd.
    if (url.pathname === '/admin/del-email') {
      if (req.headers['x-forwarded-for']) return sendJson(res, 403, { error: 'alleen lokaal' })
      const email = url.searchParams.get('email')
      if (!email) return sendJson(res, 400, { error: 'email vereist' })
      const eh = emailHashOf(email)
      if ((await verifications.get(eh))?.value) {
        await verifications.del(eh)
        console.log(`✓ (admin) binding verwijderd: ${email}`)
        return sendJson(res, 200, { deleted: true, email })
      }
      return sendJson(res, 200, { deleted: false, email, note: 'geen binding gevonden' })
    }

    sendHtml(res, 404, 'not found')
  } catch (e) {
    console.error('http-fout:', e.message)
    if (!res.headersSent) res.writeHead(500)
    res.end('error')
  }
})
httpServer.listen(HTTP_PORT, '127.0.0.1', () => console.log(`• verificatie-HTTP op 127.0.0.1:${HTTP_PORT} (nginx → /api/)`))

console.log('✅ mailer actief — notificaties + e-mailverificatie draaien.')

const shutdown = async () => {
  try { httpServer.close() } catch {}
  try { await orbitdb.stop() } catch {}
  try { await ipfs.stop() } catch {}
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
