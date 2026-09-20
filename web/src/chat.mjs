/**
 * MyChat Abundomy-spoor — chat-client module (Route B optie 1).
 *
 * Open/transparante chat als dapp-feature in de Abundomy-SPA. Eén openbare kamer.
 * Elke client:
 *   - leest de ingelogde dapp-user (usersId + profielnaam) + dapp-taal;
 *   - ondertekent elk uitgaand bericht met de Ed25519-account-sleutel
 *     (deterministisch uit de seed via deriveAccountKey) — anti-fraud:
 *     non-repudiation + anti-impersonation;
 *   - vertaalt server-side (relay) in de doeltaal uit de taal-gate;
 *   - publiceert de openbare geschiedenis (plaintext + signatures) naar IPFS
 *     via de gedeelde dapp-Helia-node — immutable CIDs = niet te herschrijven.
 *
 * Openbaar plaintext = Abundomy-ethos (transparantie = verifieerbaarheid).
 * Fraud-bescherming komt uit signing + immutability + identity, NIET uit verbergen.
 *
 * Afhankelijk van de app-mjs globals (me/node/myProfile/accountSeed) die via
 * renderChat() worden meegegeven — dit module houdt zijn eigen ws + state bij.
 */
import { unixfs } from '@helia/unixfs'
import { CID } from 'multiformats/cid'
import { publicKeyFromRaw } from '@libp2p/crypto/keys'
import { utf8ToBytes } from '@noble/hashes/utils.js'
import { deriveAccountKey } from '../../src/identity.mjs'
import { chatTargetLang, isChatLangSupported, gateLangName, getGateLangs, setLangEnabled, resetGateOverrides, loadGateLangs } from './chat-gate.mjs'

// --- Relay-config -----------------------------------------------------------
// Haalt de chat-relay-URL uit chat.json (naast relay.json), anders ENV, anders
// lokale dev-default. In dev draait de relay op ws://localhost:8095/ws.
let _chatCfg = null
async function chatCfg() {
  if (_chatCfg) return _chatCfg
  try { _chatCfg = await (await fetch('chat.json').catch(() => null))?.json() } catch {}
  _chatCfg = _chatCfg || {}
  return _chatCfg
}
function pinCfg() { return _chatCfg?.pin || null }

function relayWsUrl() {
  // expliciete override
  if (_chatCfg?.ws) return _chatCfg.ws
  // ENV-achtig via window
  if (typeof window !== 'undefined' && window.MYCHAT_RELAY_WS) return window.MYCHAT_RELAY_WS
  // dev-default
  return 'ws://localhost:8095/ws'
}

// --- State (per sessie) -----------------------------------------------------
let ws = null
let wsOpen = false
let myKey = null      // { pubkey, sign } uit deriveAccountKey
let roomHistory = []  // alle berichten (signed + vertaald) die we hebben gezien
let latestCid = null  // laatste IPFS-CID van de gepubliceerde geschiedenis
let ipnsName = null   // (stretch) IPNS-naam, als gepubliceerd
let pingTimer = null
let ipfsPublishTimer = null
let lastIpfsAt = 0
let _ctx = null       // { me, profile, node, accountSeed, dappLang, t }

// --- Vertaal-statuschip (lokale-vertaling indicator, 20 sep 2026) ------------
// Haalt runtime de vertaalstatus op bij de relay (/relay-health → {backend, translateOk});
// NIET gebakken in de bundel (zelfde patroon als relay.json/chat.json). Faalt de call
// (of translateOk=false) → chip toont "vertaling niet beschikbaar".
let xlateTimer = null
let xlateState = { backend: null, translateOk: null, checked: false }
function renderXlateChip() {
  const el = $('chatXlateChip'); if (!el) return
  const { backend, translateOk, checked } = xlateState
  if (!checked) { el.className = 'chat-xlate'; el.textContent = '…'; el.title = ''; return }
  if (translateOk === false || backend === null) { el.className = 'chat-xlate down'; el.textContent = _ctx.t('CHAT_XLATE_DOWN'); el.title = ''; return }
  if (backend === 'libre') { el.className = 'chat-xlate ok'; el.textContent = _ctx.t('CHAT_XLATE_LOCAL'); el.title = 'LibreTranslate @ SER5 (self-hosted)' }
  else if (backend === 'google') { el.className = 'chat-xlate cloud'; el.textContent = _ctx.t('CHAT_XLATE_CLOUD'); el.title = 'Google Translate API (cloud)' }
  else if (backend === 'mock') { el.className = 'chat-xlate mock'; el.textContent = _ctx.t('CHAT_XLATE_MOCK'); el.title = 'mock-backend (test)' }
  else { el.className = 'chat-xlate down'; el.textContent = _ctx.t('CHAT_XLATE_DOWN'); el.title = '' }
}
function startXlatePolling() {
  if (xlateTimer) return // idempotent — de dapp re-rendert de view elke ~2.5s
  const poll = async () => {
    try {
      const r = await fetch('/relay-health', { cache: 'no-store' })
      const j = await r.json()
      xlateState = { backend: j.backend, translateOk: j.translateOk, checked: true }
    } catch {
      xlateState = { backend: null, translateOk: false, checked: true }
    }
    renderXlateChip()
  }
  poll().catch(() => {})
  xlateTimer = setInterval(() => { poll().catch(() => {}) }, 30000)
}

// --- Helpers ----------------------------------------------------------------
const $ = (id) => document.getElementById(id)
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

/** Verifieer een Ed25519-handtekening tegen een hex-pubkey. */
async function verifySig(pubkeyHex, msg, sigHex) {
  if (!pubkeyHex || !sigHex) return false
  try { return await publicKeyFromRaw(hexToBytes(pubkeyHex)).verify(utf8ToBytes(msg), hexToBytes(sigHex)) }
  catch { return false }
}
const hexToBytes = (h) => new Uint8Array(h.match(/.{2}/g).map((b) => parseInt(b, 16)))

/** Signeer een bericht-string met de account-sleutel. */
async function signMsg(text, ts) {
  if (!myKey) throw new Error('geen account-sleutel beschikbaar — log opnieuw in met wachtwoord')
  const msg = signable(myKey.pubkey, ts, text)
  return { sig: await myKey.sign(msg), pubkey: myKey.pubkey, msg }
}
const signable = (pubkey, ts, text) => `mychat:${pubkey}:${ts}:${text}`

// --- IPFS-geschiedenis (open/transparant) -----------------------------------
/** Bouw de openbare history-payload (zelfde bytes voor Helia-lokaal én Pi-pin). */
function buildHistoryBytes() {
  return new TextEncoder().encode(JSON.stringify({
    room: 'abundomy',
    publishedBy: _ctx.me,
    publishedAt: new Date().toISOString(),
    count: roomHistory.length,
    messages: roomHistory,
  }, null, 2))
}

/** Pin de history-JSON op de PoC-host (PBFS2/IPFS-anchor) via de mini-pin-service. */
async function pinToService(bytes) {
  const cfg = pinCfg()
  if (!cfg?.url || !cfg?.token) { return { ok: false, reason: 'geen pin-config' }
  }
  const r = await fetch(cfg.url + '/pin', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + cfg.token, 'Content-Type': 'application/json' },
    body: bytes,
  })
  if (!r.ok) { const t = await r.text().catch(() => ''); return { ok: false, reason: 'HTTP ' + r.status + ' ' + t } }
  const j = await r.json().catch(() => ({}))
  if (!j.ok || !j.cid) return { ok: false, reason: 'bad response' }
  return { ok: true, cid: j.cid, size: j.size }
}

/** Publiceer de geschiedenis: Pi-pin (primair/authoritatief) + Helia-lokaal (best-effort). */
async function publishHistory() {
  if (!roomHistory.length) return
  const now = Date.now()
  if (now - lastIpfsAt < 2000) return // throttle: max 1× per 2s
  lastIpfsAt = now
  const bytes = buildHistoryBytes()

  // 1) Pi-pin (primair — dit is de openbaar leesbare, gepinde bron).
  let pinnedCid = null
  try {
    const res = await pinToService(bytes)
    if (res.ok) pinnedCid = res.cid
    else { const el = $('chatHistoryErr'); if (el) el.textContent = 'pin-service: ' + (res.reason || 'onbekend') }
  }
  catch (e) { const el = $('chatHistoryErr'); if (el) el.textContent = 'pin-service: ' + e.message }
  if (pinnedCid) {
    latestCid = pinnedCid
    const el = $('chatHistoryCid'); if (el) el.textContent = pinnedCid
    const st = $('chatPinStatus'); if (st) { st.textContent = _ctx.t('CHAT_PINNED_PI'); st.className = 'muted ok' }
  } else {
    const st = $('chatPinStatus'); if (st) { st.textContent = _ctx.t('CHAT_PIN_FAIL'); st.className = 'muted warn' }
  }

  // 2) Helia-lokaal (best-effort cache op de eigen dapp-node; CID kan verschillen
  //    van de Pi-CID door wrapping-flags — dat is geen probleem, de Pi-CID is de
  //    authoritatieve gepinde bron).
  if (_ctx?.node?.ipfs) {
    try {
      const fs = unixfs(_ctx.node.ipfs)
      const cid = await fs.addBytes(bytes)
      const el = $('chatLocalCid'); if (el) el.textContent = cid.toString()
    } catch (e) { const el = $('chatHistoryErr'); if (el) el.textContent = 'local: ' + e.message }
  }
}

// --- WebSocket --------------------------------------------------------------
function openSocket() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return
  const url = relayWsUrl()
  ws = new WebSocket(url)
  $('chatStatus').textContent = _ctx.t('CHAT_CONNECTING')
  ws.onopen = () => {
    wsOpen = true
    $('chatStatus').textContent = _ctx.t('CHAT_CONNECTED')
    // hello met gate-doeltaal + identity
    ws.send(JSON.stringify({
      type: 'hello',
      usersId: _ctx.me,
      pubkey: myKey?.pubkey || '',
      display: _ctx.profile?.usersName || ('#' + _ctx.me),
      lang: chatTargetLang(_ctx.dappLang),
    }))
    // keepalive (sommige proxies droppen inactieve ws)
    clearInterval(pingTimer)
    pingTimer = setInterval(() => { if (ws?.readyState === WebSocket.OPEN) try { ws.send(JSON.stringify({ type: 'ping' })) } catch {} }, 25000)
  }
  ws.onmessage = (ev) => onMessage(ev).catch((e) => console.warn('chat msg fout:', e))
  ws.onclose = () => {
    wsOpen = false
    if (_ctx) $('chatStatus').textContent = _ctx.t('CHAT_DISCONNECTED')
    clearInterval(pingTimer)
    // auto-reconnect zolang de view open is
    setTimeout(() => { if (_ctx && _ctx.alive) openSocket() }, 2000)
  }
  ws.onerror = () => { if (_ctx) $('chatStatus').textContent = _ctx.t('CHAT_CONN_ERR') }
}

async function onMessage(ev) {
  let m
  try { m = JSON.parse(ev.data) } catch { return }
  switch (m.type) {
    case 'hello_ack':
      $('chatRoom').textContent = m.room || 'abundomy'
      break
    case 'peers':
      $('chatPeers').textContent = m.peers && m.peers.length
        ? m.peers.map((p) => esc(p.display)).join(', ')
        : _ctx.t('CHAT_ALONE')
      break
    case 'history':
      for (const h of m.messages || []) { roomHistory.push(h); renderMessage(h, /*fromHistory*/ true) }
      schedulePublish()
      break
    case 'typing':
      showTyping(m.display || ('#' + m.from), m.is_typing)
      break
    case 'message':
      roomHistory.push(m)
      renderMessage(m)
      schedulePublish()
      break
    case 'ping': break
  }
}

let publishScheduled = false
function schedulePublish() {
  if (publishScheduled) return
  publishScheduled = true
  setTimeout(() => { publishScheduled = false; publishHistory().catch(() => {}) }, 800)
}

// --- Render -----------------------------------------------------------------
/**
 * Rendert één bericht. Voor niet-eigen berichten met een Ed25519-signature wordt
 * de signature async geverifieerd (non-blocking) en de badge bijgewerkt:
 *   ✓ groen = geldig, ✗ rood = ongeldig, ⊘ grijs = niet ondertekend, … = verifiëren.
 * De signable-string moet exact overeenkomen met signMsg(): `mychat:<pubkey>:<ts>:<text>`.
 */
function renderMessage(m, fromHistory = false) {
  const mine = fromHistory ? (m.from === _ctx.me) : !!m.mine
  const wrap = document.createElement('div')
  wrap.className = 'chat-msg ' + (mine ? 'mine' : 'theirs')
  const from = mine ? _ctx.t('CHAT_ME') : (m.display || ('#' + m.from))
  let html = '<div class="chat-from">' + esc(from)
  // Signature-badge placeholder (async bijgewerkt hierna).
  if (!mine) {
    if (m.pubkey && m.sig) {
      html += ' <span class="chat-sig chat-sig-verify" title="' + esc(_ctx.t('CHAT_VERIFYING')) + '">…</span>'
    } else {
      html += ' <span class="chat-sig chat-sig-unknown" title="' + esc(_ctx.t('CHAT_UNSIGNED')) + '">⊘</span>'
    }
  }
  html += '</div>'
  if (!mine && m.translation && m.tgtLang && m.tgtLang !== m.srcLang) {
    // Hover-title op de vertaling: "vertaald via lokaal · N ms" (alleen bij succes; bij de
    // [!]-markering (fout) ontbreekt translationMs en toont de zichtbare markering zelf al).
    const via = (m.translationMs > 0) ? _ctx.t('CHAT_XLATE_HOVER', m.translationMs) : ''
    html += '<div class="chat-text"' + (via ? ' title="' + esc(via) + '"' : '') + '>' + esc(m.translation) + '</div>'
    html += '<div class="chat-orig">[' + esc(m.srcLang || '?') + '] ' + esc(m.text) + '</div>'
  } else {
    html += '<div class="chat-text">' + esc(mine ? m.text : (m.translation || m.text)) + '</div>'
  }
  if (fromHistory) html += '<div class="chat-meta">' + _ctx.t('CHAT_HISTORY') + '</div>'
  wrap.innerHTML = html
  const box = $('chatMessages')
  box.appendChild(wrap)
  box.scrollTop = box.scrollHeight

  // Async Ed25519-verify van de signature (non-blocking). Lezer kan zo zien of een
  // bericht écht afkomstig is van de beweerde dapp-identity (anti-impersonation).
  if (!mine && m.pubkey && m.sig) {
    const badge = wrap.querySelector('.chat-sig')
    const msg = signable(m.pubkey, m.ts, m.text)
    verifySig(m.pubkey, msg, m.sig).then((ok) => {
      if (!badge) return
      badge.classList.remove('chat-sig-verify')
      if (ok) {
        badge.classList.add('chat-sig-ok')
        badge.textContent = '✓'
        badge.title = _ctx.t('CHAT_VERIFIED')
      } else {
        badge.classList.add('chat-sig-bad')
        badge.textContent = '✗'
        badge.title = _ctx.t('CHAT_INVALID_SIG')
      }
    }).catch(() => {
      if (!badge) return
      badge.classList.remove('chat-sig-verify')
      badge.classList.add('chat-sig-unknown')
      badge.textContent = '?'
      badge.title = _ctx.t('CHAT_VERIFY_ERR')
    })
  }
}

let typingTimer = null
function showTyping(display, isTyping) {
  const el = $('chatTyping')
  if (isTyping) {
    el.textContent = display + ' ' + _ctx.t('CHAT_TYPING')
    el.classList.add('active')
    clearTimeout(typingTimer)
    typingTimer = setTimeout(() => { el.classList.remove('active'); el.textContent = '' }, 3500)
  } else {
    el.classList.remove('active'); el.textContent = ''
    clearTimeout(typingTimer)
  }
}

let notifyTypingTimer = null
function notifyTyping(isTyping) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return
  ws.send(JSON.stringify({ type: 'typing', is_typing: isTyping }))
}

// --- Composer-actions (exported voor app.mjs event-wiring) ------------------
export async function sendChatMessage() {
  const input = $('chatText')
  const text = input.value.trim()
  if (!text || !ws || ws.readyState !== WebSocket.OPEN) return
  if (!myKey) { $('chatStatus').textContent = _ctx.t('CHAT_NO_KEY'); return }
  const ts = Date.now()
  const { sig, pubkey } = await signMsg(text, ts)
  const srcLang = chatTargetLang(_ctx.dappLang)
  ws.send(JSON.stringify({ type: 'message', text, sig, pubkey, srcLang, ts }))
  input.value = ''
  notifyTyping(false)
  clearTimeout(notifyTypingTimer)
  input.focus()
}

export function onChatInput() {
  notifyTyping(true)
  clearTimeout(notifyTypingTimer)
  notifyTypingTimer = setTimeout(() => notifyTyping(false), 1200)
}

// --- Hoofd-entry: rendert de view + opent de verbinding ---------------------
export async function renderChat(ctx) {
  // ctx = { me, profile, node, accountSeed, dappLang, t, alive }
  _ctx = ctx
  _ctx.alive = true
  const root = $('view-chat')
  await loadGateLangs() // laad chat-langs.json + localStorage-overrides (interactieve taal-set)
  await chatCfg()        // laad chat.json (ws-URL + pin.url/token) vóór openSocket/pinToService
  // taal-gate status
  const supported = isChatLangSupported(ctx.dappLang)
  const tgt = chatTargetLang(ctx.dappLang)
  const gateNote = supported
    ? _ctx.t('CHAT_GATE_OK', gateLangName(ctx.dappLang))
    : _ctx.t('CHAT_GATE_FALLBACK', ctx.dappLang, gateLangName('en'))
  // talen-set toggle-rij (interactief beheren)
  const langsRows = getGateLangs().map((l) =>
    `\n      <label class="chat-lang-row ${l.enabled ? 'on' : 'off'}"><input type="checkbox" data-lang="${esc(l.code)}" ${l.enabled ? 'checked' : ''} /> <span class="chat-lang-name">${esc(l.name)}</span> <span class="chat-lang-iso">${esc(l.iso)}</span></label>`).join('')
  // account-sleutel (seed beschikbaar?)
  if (ctx.accountSeed) {
    try { myKey = await deriveAccountKey(ctx.accountSeed) }
    catch (e) { myKey = null; $('chatStatus').textContent = _ctx.t('CHAT_KEY_ERR') + ': ' + e.message }
  } else {
    myKey = null
  }
  root.innerHTML = `
    <div class="medium_line"></div>
    <div class="index-title-row">
      <div class="index-title-column"><p class="title">${esc(_ctx.t('CHAT_TITLE'))}</p></div>
      <div class="index-title-column" style="justify-content:flex-end;">
        <span class="muted" id="chatStatus">${esc(_ctx.t('CHAT_IDLE'))}</span>
      </div>
    </div>
    <div class="full_line"></div>
    <p class="muted chat-gate ${supported ? 'ok' : 'fallback'}" id="chatGateNote">${esc(gateNote)}</p>
    <p class="muted chat-identity">
      ${esc(_ctx.t('CHAT_IDENTITY', String(ctx.profile?.usersName || ('#'+ctx.me)), String(ctx.me)))}
      ${myKey ? '' : '<span class="chat-warn"> — ' + esc(_ctx.t('CHAT_NO_KEY')) + '</span>'}
    </p>
    <div class="chat-header">
      <span><b>${esc(ctx.profile?.usersName || ('#'+ctx.me))}</b> · <span id="chatLang">${esc(tgt)}</span></span>
      <span class="room">kamer: <span id="chatRoom">…</span></span>
      <span class="peers" id="chatPeers">—</span>
      <span class="chat-xlate" id="chatXlateChip" title="">…</span>
    </div>
    <div class="chat-messages" id="chatMessages"></div>
    <div class="chat-typing" id="chatTyping"></div>
    <form class="chat-composer" id="chatComposer" autocomplete="off">
      <input id="chatText" placeholder="${esc(_ctx.t('CHAT_PLACEHOLDER'))}" ${myKey ? '' : 'disabled'} />
      <button type="submit" ${myKey ? '' : 'disabled'}>${esc(_ctx.t('CHAT_SEND'))}</button>
    </form>
    <details class="chat-langs-details">
      <summary class="muted">${esc(_ctx.t('CHAT_LANGS_TITLE'))}</summary>
      <p class="muted">${esc(_ctx.t('CHAT_LANGS_HINT'))}</p>
      <div class="chat-lang-list">${langsRows}</div>
      <div class="actions" style="justify-content:flex-start; margin-top:0.4rem;">
        <button type="button" class="btn-secondary" id="chatLangsReset">${esc(_ctx.t('CHAT_LANGS_RESET'))}</button>
      </div>
      <p class="chat-err" id="chatLangsErr"></p>
    </details>
    <details class="chat-history-details">
      <summary class="muted">${esc(_ctx.t('CHAT_HISTORY_SUMMARY'))}</summary>
      <p class="muted">${esc(_ctx.t('CHAT_HISTORY_DESC'))}</p>
      <p class="muted" id="chatPinStatus">${esc(_ctx.t('CHAT_PIN_IDLE'))}</p>
      <p class="muted">Gepind op PBFS2/IPFS-anchor (authoritatief): <code id="chatHistoryCid">${esc(latestCid || '—')}</code></p>
      <p class="muted">Lokaal (Helia, best-effort): <code id="chatLocalCid">—</code></p>
      <p class="chat-err" id="chatHistoryErr"></p>
    </details>
  `
  // --- herstel dynamische state na (re)render ---
  // (De dapp's periodieke render() roept renderChat elke ~2.5s opnieuw aan, wat de
  //  innerHTML reset. De ws-verbinding staat dan nog open, maar openSocket() returnt
  //  vroeg en zet de status niet opnieuw. Hier herstellen we status + history + CID.)
  const stEl = $('chatStatus')
  if (stEl) {
    if (ws && ws.readyState === WebSocket.OPEN) stEl.textContent = _ctx.t('CHAT_CONNECTED')
    else if (ws && ws.readyState === WebSocket.CONNECTING) stEl.textContent = _ctx.t('CHAT_CONNECTING')
    else stEl.textContent = _ctx.t('CHAT_DISCONNECTED')
  }
  const roomEl = $('chatRoom'); if (roomEl) roomEl.textContent = 'abundomy'
  // vertaal-statuschip: herstel laatste bekende state + start polling (idempotent)
  renderXlateChip()
  startXlatePolling()
  if (latestCid) { const el = $('chatHistoryCid'); if (el) el.textContent = latestCid }
  if (roomHistory.length) {
    const box = $('chatMessages')
    for (const m of roomHistory) { try { renderMessage(m, true) } catch {} }
    if (box) box.scrollTop = box.scrollHeight
  }
  // composer-wiring
  $('chatComposer').addEventListener('submit', (e) => { e.preventDefault(); sendChatMessage().catch((err) => $('chatStatus').textContent = 'FOUT: ' + err.message) })
  $('chatText').addEventListener('input', onChatInput)
  // talen-set toggle-wiring (interactief)
  const refreshGate = () => {
    const sup = isChatLangSupported(_ctx.dappLang)
    const t2 = chatTargetLang(_ctx.dappLang)
    const note = sup ? _ctx.t('CHAT_GATE_OK', gateLangName(_ctx.dappLang)) : _ctx.t('CHAT_GATE_FALLBACK', _ctx.dappLang, gateLangName('en'))
    const el = $('chatGateNote'); if (el) { el.textContent = note; el.className = 'muted chat-gate ' + (sup ? 'ok' : 'fallback') }
    const lg = $('chatLang'); if (lg) lg.textContent = t2
  }
  root.querySelectorAll('.chat-lang-row input[type=checkbox]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const code = cb.getAttribute('data-lang')
      setLangEnabled(code, cb.checked)
      cb.closest('.chat-lang-row')?.classList.toggle('on', cb.checked)
      cb.closest('.chat-lang-row')?.classList.toggle('off', !cb.checked)
      refreshGate()
    })
  })
  $('chatLangsReset')?.addEventListener('click', async () => {
    try { await resetGateOverrides(); await renderChat(_ctx) /* herrender met schone set */ }
    catch (e) { const el = $('chatLangsErr'); if (el) el.textContent = 'reset: ' + e.message }
  })
  // (her)open socket
  openSocket()
}

export function closeChat() {
  _ctx = _ctx ? Object.assign(_ctx, { alive: false }) : null
  if (ws) { try { ws.close() } catch {} }
  ws = null
  clearInterval(pingTimer)
  clearInterval(xlateTimer); xlateTimer = null
}