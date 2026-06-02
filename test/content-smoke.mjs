/**
 * Content-site-smoke: drijft de gebouwde content-site (`web/site-dist/`) aan via het
 * Chrome DevTools Protocol (CDP) + systeem-`chromium` — net als test/e2e-smoke.mjs voor
 * de app. Controleert dat:
 *   - de homepagina rendert met de vlag-taalkiezer + werkende boek-cover,
 *   - de vlag-taalpagina opent en een taal kiezen de content vertaalt,
 *   - een artikel-reader rendert (tx_NN-spans gevuld, loader weg) zonder console-fouten,
 *   - de eerder ontbrekende download (OneCoinHDemo.xlsx) nu bestaat.
 *
 * Draaien:  npm run build:site && npm run test:content
 * Vereist:  `chromium` op PATH (snap) en web/site-dist/ (van build:site).
 */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const DIST = fileURLToPath(new URL('../web/site-dist/', import.meta.url))
const PORT = 8788
const DBG_PORT = 9224
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.gif': 'image/gif', '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.pdf': 'application/pdf', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf' }

// Mini-mock van de mailer-download-teller (zelfde contract als /api/downloads): zo testen
// we de client-bedrading (lezen/ophogen/tonen) zonder de echte OrbitDB-mailer.
const dl = { counts: { en: 41, de: 7, xlsx: 12 }, total: 48 }
let dlPosts = 0

function serve() {
  return new Promise((resolve) => {
    const s = createServer(async (req, res) => {
      const url = new URL(req.url, 'http://x')
      if (url.pathname === '/api/downloads') {
        if (req.method === 'POST') {
          let raw = ''; for await (const c of req) raw += c
          const key = (JSON.parse(raw || '{}').lang || 'en')
          dl.counts[key] = (dl.counts[key] || 0) + 1; if (key.length === 2) dl.total++ // totaal = alleen taalcodes
          dlPosts++
        }
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(dl)); return
      }
      let p = decodeURIComponent(url.pathname)
      if (p === '/' || p.endsWith('/')) p += 'index.html'
      try {
        const body = await readFile(join(DIST, p))
        res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream' })
        res.end(body)
      } catch { res.writeHead(404); res.end('nf') }
    })
    s.listen(PORT, '127.0.0.1', () => resolve(s))
  })
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiters = new Map(); this.events = []
    ws.onmessage = (m) => { const msg = JSON.parse(m.data)
      if (msg.id && this.waiters.has(msg.id)) { this.waiters.get(msg.id)(msg); this.waiters.delete(msg.id) }
      else if (msg.method) this.events.push(msg) } }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.waiters.set(id, (m) => m.error ? reject(new Error(m.error.message)) : resolve(m.result))
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
    return r.result.value
  }
  async goto(url) { await this.send('Page.navigate', { url }); await sleep(2600) }
}

async function getJson(url) { return JSON.parse(await (await fetch(url)).text()) }

const checks = []
const check = (name, ok) => { checks.push({ name, ok }); console.log(`${ok ? '✓' : '✗'} ${name}`) }

async function main() {
  const server = await serve()
  const profileDir = await mkdtemp(join(homedir(), 'abundomy-content-'))
  const chrome = spawn('chromium', [
    '--headless', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${DBG_PORT}`,
    `--user-data-dir=${profileDir}`, '--no-first-run', '--disable-extensions',
    `http://127.0.0.1:${PORT}/index.html`,
  ], { stdio: 'ignore' })

  let cdp, ws
  try {
    let target
    for (let i = 0; i < 40 && !target; i++) {
      try { target = (await getJson(`http://127.0.0.1:${DBG_PORT}/json`)).find((t) => t.type === 'page') } catch {}
      if (!target) await sleep(250)
    }
    if (!target) throw new Error('geen chromium-debugger / page-target gevonden')

    ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws-fout')) })
    cdp = new CDP(ws)
    await cdp.send('Runtime.enable'); await cdp.send('Log.enable'); await cdp.send('Page.enable')
    await sleep(2600)

    // 1. homepagina: vlag-taalkiezer + boek-cover
    check('home: vlag toont een SVG', await cdp.eval(`/<svg/i.test((document.getElementById('abLangFlag')||{}).innerHTML||'')`))
    check('home: boek-cover geladen', await cdp.eval(`((document.getElementById('bookCover')||{}).naturalWidth||0) > 0`))
    check('home: tx_03 (en) gevuld', await cdp.eval(`/Download/i.test((document.getElementById('tx_03')||{}).textContent||'')`))

    // 2. download-teller: geladen uit /api/downloads (totaal + huidige-taal-count)
    check('teller: totaal + en-count geladen', await cdp.eval(
      `document.getElementById('total-count').textContent==='48' && document.getElementById('lang-count').textContent==='41'`))

    // 3. vlag-taalpagina openen + een taal kiezen vertaalt de content (én lang-count volgt)
    await cdp.eval(`window.__abOpenLang()`); await sleep(300)
    check('home: taalpagina gevuld (68 talen)', await cdp.eval(`document.querySelectorAll('#abLangList .ab-lang-item').length >= 60`))
    const en = await cdp.eval(`(document.getElementById('tx_03')||{}).textContent||''`)
    await cdp.eval(`document.querySelector('#abLangList .ab-lang-item[data-code="de"]').click()`); await sleep(500)
    const de = await cdp.eval(`(document.getElementById('tx_03')||{}).textContent||''`)
    check('home: taalwissel vertaalt content (en→de)', en !== de && /herunter|Buch/i.test(de) && await cdp.eval(`document.documentElement.lang==='de'`))
    check('teller: lang-count volgt de taal (de=7)', await cdp.eval(`document.getElementById('lang-count').textContent==='7'`))

    // 4. download tracken: optimistisch ophogen + POST naar /api/downloads
    await cdp.eval(`window.sendTracking()`); await sleep(300)
    check('teller: download verhoogt teller + POST', await cdp.eval(`document.getElementById('total-count').textContent==='49'`) && dlPosts >= 1)

    // 3. artikel-reader rendert (content gevuld, loader weg, geen fouten)
    cdp.events.length = 0
    await cdp.goto(`http://127.0.0.1:${PORT}/articles/article01-reader.html`)
    check('artikel: titel-span (tx_01) gevuld', await cdp.eval(`((document.getElementById('tx_01')||{}).textContent||'').length > 3`))
    check('artikel: content zichtbaar (loader weg)', await cdp.eval(`(function(){var c=document.getElementById('capture-section');return !!c&&getComputedStyle(c).display!=='none'})()`))
    check('artikel: vlag aanwezig', await cdp.eval(`/<svg/i.test((document.getElementById('abLangFlag')||{}).innerHTML||'')`))

    // 4. geen console-fouten op de artikelpagina
    const errors = cdp.events.filter((e) =>
      (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') || e.method === 'Runtime.exceptionThrown')
      .map((e) => e.params?.entry?.text || e.params?.exceptionDetails?.text || 'exception')
    check('artikel: geen console-fouten', errors.length === 0)
    if (errors.length) errors.forEach((t) => console.log('   ↳', t))

    // 5. artikel-pagina met de OneCoinH-demo: eigen 'xlsx'-teller laadt + telt op
    await cdp.goto(`http://127.0.0.1:${PORT}/articles/youtube01.html`)
    check('artikel-teller: xlsx-count geladen (12)', await cdp.eval(`(document.getElementById('xlsx-count')||{}).textContent==='12'`))
    const postsBefore = dlPosts
    await cdp.eval(`window.__abTrackItem('xlsx')`); await sleep(300)
    check('artikel-teller: download verhoogt teller + POST', await cdp.eval(`(document.getElementById('xlsx-count')||{}).textContent==='13'`) && dlPosts === postsBefore + 1)

    // 6. eerder ontbrekende download bestaat nu
    const xlsx = await fetch(`http://127.0.0.1:${PORT}/download/OneCoinHDemo.xlsx`)
    check('download: OneCoinHDemo.xlsx bereikbaar (200)', xlsx.status === 200)
  } finally {
    try { ws?.close() } catch {}
    try { chrome.kill('SIGKILL') } catch {}
    try { server.close() } catch {}
    await sleep(600)
    await rm(profileDir, { recursive: true, force: true }).catch(() => {})
  }

  const failed = checks.filter((c) => !c.ok)
  console.log(`\n${checks.length - failed.length}/${checks.length} checks geslaagd`)
  if (failed.length) { console.error('Content-smoke FAALT'); process.exit(1) }
  console.log('Content-smoke OK ✅')
}

main().catch((e) => { console.error('Content-smoke-fout:', e.message); process.exit(1) })
