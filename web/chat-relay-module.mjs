/**
 * P11b chat-module — port van chat-relay.mjs als additieve module in de replicator.
 *
 * 1-op-1 overgenomen uit lokale-vertaling/deploy/chat-relay.mjs (live 8096):
 * protocol (hello/hello_ack/history/peers/message/typing/ping), Translator-interface
 * (mock/libre/google), foutgedrag B4 (origineel + [!], reden alléén in log),
 * `[translate]`-logregels (B5), statuschip-contract via /health.
 *
 * Verschillen t.o.v. de relay:
 * - startChatRelay(opts)-factory i.p.v. top-level boot; opts bevatten translator-config
 *   en (optioneel) `orbitdb` voor D1-persistentie (additieve events-store, laatste N
 *   berichten herladen bij boot).
 * - listener bindt standaard op 127.0.0.1 (nginx-naad is de publieke ingang).
 * - faal-isolatie: store-fouten degraderen naar in-memory (log + door), een throw in
 *   startChatRelay mag de replicator niet nemen (afgevangen in de wiring).
 */
import http from 'node:http'
import { WebSocketServer } from 'ws'
import { IPFSAccessController } from '@orbitdb/core'

const MAX_HISTORY_DEFAULT = 100

function logTranslate(backend, ms, src, tgt, ok, extra = '') {
  const line = `[translate] backend=${backend} ms=${ms} src=${src} tgt=${tgt} ok=${ok}${extra ? ' ' + extra : ''}`
  if (ok) console.log(line); else console.error(line)
}

class GoogleTranslator {
  constructor(apiKey) { this.apiKey = apiKey }
  async translate(text, src, tgt) {
    if (src === tgt) return text
    const t0 = Date.now()
    const url = `https://translation.googleapis.com/language/translate/v2?key=${this.apiKey}`
    const body = JSON.stringify({ q: text, source: src, target: tgt, format: 'text' })
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
      if (!r.ok) throw new Error(`Google HTTP ${r.status}`)
      const j = await r.json()
      logTranslate('google', Date.now() - t0, src, tgt, true)
      return j.data.translations[0].translatedText
    } catch (e) {
      logTranslate('google', Date.now() - t0, src, tgt, false, `err="${e.message}"`)
      throw e
    }
  }
}

class LibreTranslator {
  constructor(url, apiKey) {
    this.url = String(url).replace(/\/+$/, '')
    this.apiKey = apiKey
    this._probe = null // { ok, at } — health-probe-cache 5 s
  }
  async health() {
    if (this._probe && Date.now() - this._probe.at < 5000) return this._probe
    try {
      const ctrl = new AbortController()
      const to = setTimeout(() => ctrl.abort(), 2500)
      const r = await fetch(`${this.url}/languages?api_key=${encodeURIComponent(this.apiKey)}`, { signal: ctrl.signal })
      clearTimeout(to)
      this._probe = { ok: r.ok, at: Date.now() }
    } catch {
      this._probe = { ok: false, at: Date.now() }
    }
    return this._probe
  }
  async translate(text, src, tgt) {
    if (src === tgt) return text
    const t0 = Date.now()
    const url = `${this.url}/translate`
    const body = JSON.stringify({ q: text, source: src, target: tgt, format: 'text', api_key: this.apiKey })
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
      if (!r.ok) throw new Error(`libre HTTP ${r.status}`)
      const j = await r.json()
      const out = j.translatedText
      if (typeof out !== 'string') throw new Error('libre antwoord zonder translatedText')
      logTranslate('libre', Date.now() - t0, src, tgt, true)
      return out
    } catch (e) {
      const reason = (e.cause && e.cause.code) ? e.cause.code : e.message
      logTranslate('libre', Date.now() - t0, src, tgt, false, `err="${reason}"`)
      throw new Error(String(reason))
    }
  }
}

class MockTranslator {
  async translate(text, src, tgt) {
    if (src === tgt) return text
    logTranslate('mock', 0, src, tgt, true)
    return `[${src}→${tgt}] ${text}`
  }
}

async function loadTranslator(t) {
  const backend = String(t.backend || 'mock').toLowerCase()
  if (backend === 'mock') {
    console.log('[translator] backend=mock (echo — geen echte vertaling)')
    return new MockTranslator()
  }
  if (backend === 'libre') {
    if (!t.libreUrl) throw new Error('TRANSLATOR_BACKEND=libre maar LIBRE_URL ontbreekt')
    const key = t.libreApiKey
      || (t.libreKeyFile ? (await (await import('node:fs/promises')).readFile(t.libreKeyFile, 'utf8')).trim() : '')
    if (!key) throw new Error('TRANSLATOR_BACKEND=libre maar geen LIBRE_API_KEY/LIBRE_KEY_FILE')
    console.log(`[translator] backend=libre url=${t.libreUrl} key=<gezet, fingerprint ${key.slice(0, 4)}…>`)
    return new LibreTranslator(t.libreUrl, key)
  }
  if (backend === 'google') {
    const key = t.googleKey
      || (t.googleKeyFile ? (await (await import('node:fs/promises')).readFile(t.googleKeyFile, 'utf8')).trim() : '')
    if (!key) throw new Error('Geen Google-key: zet GOOGLE_TRANSLATE_KEY of GOOGLE_KEY_FILE, of TRANSLATOR_BACKEND=mock|libre.')
    console.log('[translator] backend=google')
    return new GoogleTranslator(key)
  }
  throw new Error(`Onbekende TRANSLATOR_BACKEND='${backend}' (mock|libre|google)`)
}

/**
 * Start de chat-listener. Faalt hij, dan gooit hij — de wiring in
 * anchor-replicator.mjs vangt dat af en draait zonder chat (isolatie-principe).
 */
export async function startChatRelay(opts = {}) {
  const PORT = Number(opts.port || 4006)
  const HOST = String(opts.host || '127.0.0.1')
  const ROOM = String(opts.room || 'abundomy')
  const MAX_HISTORY = Number(opts.maxHistory || 200)

  const translator = await loadTranslator(opts.translator || {})

  const peers = new Map()
  const history = []
  let chatStore = null // D1: additieve events-store (optioneel)

  class Peer {
    constructor(ws) {
      this.ws = ws
      this.usersId = null
      this.pubkey = null
      this.display = '?'
      this.lang = 'en'
    }
    send(obj) { if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(obj)) }
  }

  function broadcast(obj, exceptWs = null) {
    for (const p of peers.keys()) if (p !== exceptWs && p.readyState === p.OPEN) p.send(JSON.stringify(obj))
  }

  function peerList() {
    return [...peers.values()].filter((p) => p.usersId != null).map((p) => ({ usersId: p.usersId, display: p.display, lang: p.lang }))
  }

  async function handleMessage(peer, msg) {
    switch (msg.type) {
      case 'hello': {
        peer.usersId = msg.usersId
        peer.pubkey = msg.pubkey
        peer.display = String(msg.display || ('#' + msg.usersId))
        peer.lang = String(msg.lang || 'en')
        peers.set(peer.ws, peer)
        console.log(`hello usersId=${msg.usersId} display="${peer.display}" lang=${peer.lang} ua=${peer.ws._socket?.remoteAddress || '?'}`)
        peer.send({ type: 'hello_ack', room: ROOM })
        peer.send({ type: 'history', messages: history.slice(-MAX_HISTORY) })
        broadcast({ type: 'peers', peers: peerList() })
        return
      }
      case 'typing': {
        broadcast({ type: 'typing', from: peer.usersId, display: peer.display, is_typing: !!msg.is_typing }, peer.ws)
        return
      }
      case 'message': {
        if (peer.usersId == null) return
        const src = String(msg.srcLang || 'en')
        const base = {
          type: 'message',
          from: peer.usersId,
          display: peer.display,
          pubkey: peer.pubkey,
          text: String(msg.text || ''),
          srcLang: src,
          sig: String(msg.sig || ''),
          ts: Number(msg.ts || Date.now()),
          translation: null,
          tgtLang: src,
        }
        peer.send({ ...base, mine: true })
        for (const other of peers.values()) {
          if (other === peer || other.usersId == null) continue
          const tgt = other.lang
          let translation = base.text
          let translationMs = null
          if (tgt !== src) {
            const t0 = Date.now()
            try { translation = await translator.translate(base.text, src, tgt); translationMs = Date.now() - t0 }
            catch (e) { translation = `${base.text}\n[!] vertaling niet beschikbaar` }
          }
          other.send({ ...base, mine: false, translation, translationMs, tgtLang: tgt })
        }
        const histEntry = { ...base, mine: false, translation: null, tgtLang: base.srcLang }
        history.push(histEntry)
        if (history.length > MAX_HISTORY) history.shift()
        if (chatStore) { try { await chatStore.add(histEntry) } catch (e) { console.error('[chat-store] add faalde (door): ' + e.message) } }
        broadcast({ type: 'peers', peers: peerList() })
        return
      }
    }
  }

  const server = http.createServer(async (req, res) => {
    if (req.url === '/health') {
      let translateOk = true
      try { if (translator && typeof translator.health === 'function') translateOk = (await translator.health()).ok } catch { translateOk = false }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, room: ROOM, backend: opts.translator?.backend || 'mock', translateOk, peers: peerList().length, history: history.length }))
      return
    }
    res.writeHead(404); res.end('MyChat Abundomy relay (replicator-module). Use WebSocket /ws.')
  })

  const wss = new WebSocketServer({ server, path: '/ws' })
  wss.on('connection', (ws) => {
    const peer = new Peer(ws)
    peers.set(ws, peer)
    ws.on('message', (data) => {
      let msg
      try { msg = JSON.parse(data.toString()) } catch { return }
      handleMessage(peer, msg).catch((e) => peer.send({ type: 'error', error: String(e.message) }))
    })
    ws.on('close', () => { peers.delete(ws); broadcast({ type: 'peers', peers: peerList() }) })
    ws.on('error', () => peers.delete(ws))
  })

  // D1: persistente chat-store (additief; faalt → in-memory fallback met log).
  // Opts byte-gelijk aan openStores in src/stores.mjs (sync:true + write:['*']-ACL):
  // deterministisch zelfde manifest/adres op anker én datanode — anders syncen de
  // peers stilletjes verschillende stores. Error-listener is verplicht (stores.mjs-
  // les: ongevangen 'error'-event beëindigt anders het hele proces).
  if (opts.orbitdb) {
    try {
      chatStore = await opts.orbitdb.open('chat-abundomy', {
        type: 'events',
        sync: true,
        AccessController: IPFSAccessController({ write: ['*'] }),
      })
      chatStore.events.on('error', (e) => console.warn(`⚠ sync-fout in chat-store (genegeerd): ${e?.message || e}`))
      let loaded = 0
      for await (const e of chatStore.iterator({ limit: MAX_HISTORY })) { history.push(e.value); loaded++ }
      console.log(`[chat-store] 'chat-abundomy' open (${chatStore.address}) — ${loaded} berichten herladen`)
    } catch (e) {
      chatStore = null
      console.log(`[chat-store] openen faalde → in-memory fallback: ${e.message}`)
    }
  }

  await new Promise((resolve) => server.listen(PORT, HOST, resolve))
  console.log(`[chat] MyChat Abundomy-relay (replicator-module) op ${HOST}:${PORT} — ws /ws, health /health, kamer "${ROOM}" (${history.length} history)`)
  return { server, wss, stop: async () => { try { wss.close() } catch {} ; try { server.close() } catch {} } }
}
