/**
 * E2E-smoke voor de gebouwde SPA — drijft de systeem-chromium aan via het Chrome
 * DevTools Protocol (CDP) over Node's ingebouwde WebSocket. GEEN Playwright (dat
 * steunt geen chromium op Ubuntu 26.04) en GEEN relay/mailer/productie: dit test
 * puur dat de bundel boot en de UI rendert (login → signup+foto → reset), zonder
 * console-fouten. Verbindingen met de relay komen pas bij inloggen/aanmelden, dus
 * passief laden raakt geen data.
 *
 * Draaien:  npm run build:web && npm run test:e2e
 * Vereist:  `chromium` op PATH (snap), en dist-web/ (van build:web).
 */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const DIST = fileURLToPath(new URL('../dist-web/', import.meta.url))
const PORT = 8787
const DBG_PORT = 9223
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.gif': 'image/gif', '.ico': 'image/x-icon', '.svg': 'image/svg+xml' }

// ---- statische server voor de build ----
function serve() {
  return new Promise((resolve) => {
    const s = createServer(async (req, res) => {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname)
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

// ---- minimale CDP-client over de ingebouwde WebSocket ----
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
}

async function getJson(url) { return JSON.parse(await (await fetch(url)).text()) }

const checks = []
const check = (name, ok) => { checks.push({ name, ok }); console.log(`${ok ? '✓' : '✗'} ${name}`) }

async function main() {
  const server = await serve()
  // Onder $HOME en NIET-verborgen (snap-chromium kan niet in /tmp of dot-mappen).
  const profileDir = await mkdtemp(join(homedir(), 'abundomy-e2e-'))
  const chrome = spawn('chromium', [
    '--headless', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${DBG_PORT}`,
    `--user-data-dir=${profileDir}`, '--no-first-run', '--disable-extensions',
    `http://127.0.0.1:${PORT}/index.html`,
  ], { stdio: 'ignore' })

  let cdp, ws
  try {
    // wacht tot de debugger luistert en pak het page-target
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

    // geef de SPA tijd om te booten
    await sleep(2500)

    // 1. login-scherm rendert
    check('login-scherm zichtbaar', await cdp.eval(`!!document.getElementById('loginBtn') && !document.getElementById('login').classList.contains('hidden')`))
    check('relay.json geladen (status-tekst)', await cdp.eval(`/Relay gevonden|Geen relay/.test(document.getElementById('relayInfo').textContent)`))

    // 2. naar signup → formulier + fotokiezer aanwezig
    await cdp.eval(`document.getElementById('toSignupBtn').click()`); await sleep(300)
    check('signup-formulier zichtbaar', await cdp.eval(`!document.getElementById('signup').classList.contains('hidden')`))
    check('signup: fotokiezer aanwezig', await cdp.eval(`!!document.getElementById('suImgFile') && !!document.getElementById('suImgPreview')`))
    check('signup: wachtwoordveld aanwezig', await cdp.eval(`!!document.getElementById('suPwd')`))

    // 3. naar reset → formulier aanwezig
    await cdp.eval(`document.getElementById('toLogin').click()`); await sleep(150)
    await cdp.eval(`document.getElementById('toResetBtn').click()`); await sleep(300)
    check('reset-formulier zichtbaar', await cdp.eval(`!document.getElementById('resetCard').classList.contains('hidden')`))

    // 4. taalvlag + taalpagina: vlag toont een SVG, een ECHTE tik (coördinaat, met
    //    hit-testing) opent de zoek/vlaggenlijst, een taal kiezen vertaalt + sluit.
    check('taalvlag toont een SVG', await cdp.eval(`/<svg/i.test(document.getElementById('langFlag').innerHTML)`))
    // Hit-test: het midden van de vlag mag NIET op een navbalk-link liggen (anders
    // verlaat een tik nét daar de app) — het bovenste element zit in #langFlag.
    check('vlag-hoek is vrij (geen nav-link eronder)', await cdp.eval(
      `(() => { const f = document.getElementById('langFlag'); const b = f.getBoundingClientRect();
        const el = document.elementFromPoint(b.x + b.width/2, b.y + b.height/2);
        return !!(el && f.contains(el)); })()`))
    // Echte muisklik op het vlag-midden via CDP-Input (respecteert stacking/pointer-events).
    const fb = await cdp.eval(`(() => { const b = document.getElementById('langFlag').getBoundingClientRect();
      return JSON.stringify({ x: b.x + b.width/2, y: b.y + b.height/2 }); })()`)
    const fc = JSON.parse(fb)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: fc.x, y: fc.y, button: 'left', clickCount: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: fc.x, y: fc.y, button: 'left', clickCount: 1 })
    await sleep(250)
    check('taalpagina open + gevuld (68 talen)', await cdp.eval(
      `!document.getElementById('langOverlay').classList.contains('hidden') && document.querySelectorAll('#langListBox .lang-item').length >= 60`))
    check('lijst-items hebben een vlag-SVG', await cdp.eval(`!!document.querySelector('#langListBox .flag-container svg')`))
    // Zoekfilter: typ "deutsch" → alleen Duits zichtbaar
    await cdp.eval(`(() => { const s = document.getElementById('langSearch'); s.value = 'deutsch'; s.dispatchEvent(new Event('input')); })()`); await sleep(150)
    const visible = await cdp.eval(`[...document.querySelectorAll('#langListBox .lang-item')].filter(i => i.style.display !== 'none').length`)
    check('zoekfilter werkt (deutsch → 1 resultaat)', visible === 1)
    // Forceer eerst Engels, dan Duits — via klik op het lijst-item (zoals een gebruiker).
    await cdp.eval(`document.getElementById('langFlag').click()`); await sleep(150) // heropen (was nog open) — toggle niet, dus opnieuw bouwen
    await cdp.eval(`document.querySelector('#langListBox .lang-item input[value="en"]').closest('.lang-item').click()`); await sleep(200)
    const loginEn = await cdp.eval(`document.querySelector('[data-i18n="LOGIN"]').textContent.trim()`)
    const closedAfterPick = await cdp.eval(`document.getElementById('langOverlay').classList.contains('hidden')`)
    await cdp.eval(`document.getElementById('langFlag').click()`); await sleep(150)
    await cdp.eval(`document.querySelector('#langListBox .lang-item input[value="de"]').closest('.lang-item').click()`); await sleep(200)
    const loginDe = await cdp.eval(`document.querySelector('[data-i18n="LOGIN"]').textContent.trim()`)
    check('taal kiezen vertaalt UI + sluit pagina (en→de)', loginEn === 'Login' && loginDe === 'Anmelden' && closedAfterPick === true)

    // 5. geen ernstige console-fouten / excepties tijdens het laden
    const errors = cdp.events.filter((e) =>
      (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') ||
      e.method === 'Runtime.exceptionThrown')
      // gateway/relay-netwerkruis negeren we niet hier, want we verbinden niet — alle errors tellen
      .map((e) => e.params?.entry?.text || e.params?.exceptionDetails?.text || 'exception')
    check('geen console-fouten / excepties', errors.length === 0)
    if (errors.length) errors.forEach((t) => console.log('   ↳', t))
  } finally {
    try { ws?.close() } catch {}
    try { chrome.kill('SIGKILL') } catch {}
    try { server.close() } catch {}
    await sleep(600) // chromium z'n profielbestanden laten loslaten
    await rm(profileDir, { recursive: true, force: true }).catch(() => {})
  }

  const failed = checks.filter((c) => !c.ok)
  console.log(`\n${checks.length - failed.length}/${checks.length} checks geslaagd`)
  if (failed.length) { console.error('E2E-smoke FAALT'); process.exit(1) }
  console.log('E2E-smoke OK ✅')
}

main().catch((e) => { console.error('E2E-fout:', e.message); process.exit(1) })
