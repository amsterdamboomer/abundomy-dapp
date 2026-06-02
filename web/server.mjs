/**
 * Productie-entry: één proces dat (a) de relay opstart, (b) de gebuilde SPA
 * serveert vanuit `dist-web/`, (c) WS-upgrades proxiet naar de interne libp2p
 * WS-listener op localhost. TLS wordt door Fly aan de rand afgehandeld.
 *
 * Bedoeld voor de Docker-container. Lokaal dev blijft gewoon `npm run relay` +
 * `npm run dev`.
 */
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { extname, resolve } from 'node:path'
import { startRelay } from './relay.mjs'
import { storeAddresses } from '../src/stores.mjs'

const PORT = Number(process.env.PORT) || 8080
const RELAY_WS_PORT = Number(process.env.ABUNDOMY_RELAY_WS_PORT) || 9091
const STATIC_DIR = fileURLToPath(new URL('../dist-web/', import.meta.url))

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico':  'image/x-icon',
  '.woff':  'font/woff',
  '.woff2': 'font/woff2',
  '.map':  'application/json',
  '.txt':  'text/plain; charset=utf-8',
}

console.log('[server] relay opstarten…')
const relay = await startRelay({
  bind: process.env.ABUNDOMY_RELAY_BIND ?? '127.0.0.1',
})
console.log(`[server] relay peerId: ${relay.peerId}`)
console.log(`[server] relay publiek adres: ${relay.publicAddr ?? '(geen ABUNDOMY_ANNOUNCE gezet)'}`)

const relayJson = JSON.stringify({
  addr: relay.publicAddr ?? relay.wsAddr,
  stores: storeAddresses(relay.stores),
}, null, 2)

const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent((req.url || '/').split('?')[0])

    if (p === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok')
      return
    }

    if (p === '/relay.json') {
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      res.end(relayJson)
      return
    }

    if (p === '/' || p.endsWith('/')) p = `${p}index.html`
    const full = resolve(STATIC_DIR, '.' + p)
    if (!full.startsWith(STATIC_DIR)) {
      res.writeHead(403); res.end('Forbidden'); return
    }

    const st = await stat(full).catch(() => null)
    if (!st || !st.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('Not found')
      return
    }

    const body = await readFile(full)
    res.writeHead(200, {
      'content-type': MIME[extname(full).toLowerCase()] || 'application/octet-stream',
      'cache-control': p.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=60',
    })
    res.end(body)
  } catch (err) {
    console.error('[server] request error:', err)
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' })
    res.end('Internal error')
  }
})

// WebSocket-upgrade → forward naar de interne libp2p WS-listener op 127.0.0.1.
// We pipen ruwe sockets; libp2p completeert de WS-handshake en de noise/yamux/floodsub-stack.
server.on('upgrade', (req, socket, head) => {
  socket.setNoDelay(true)
  const upstream = connect(RELAY_WS_PORT, '127.0.0.1')

  upstream.once('connect', () => {
    let header = `GET ${req.url} HTTP/1.1\r\n`
    for (const [k, v] of Object.entries(req.headers)) {
      if (Array.isArray(v)) for (const vv of v) header += `${k}: ${vv}\r\n`
      else header += `${k}: ${v}\r\n`
    }
    header += '\r\n'
    upstream.write(header)
    if (head && head.length) upstream.write(head)
    socket.pipe(upstream)
    upstream.pipe(socket)
  })

  const kill = (why) => () => {
    try { upstream.destroy() } catch {}
    try { socket.destroy() } catch {}
    if (why) console.warn('[ws-proxy]', why)
  }
  upstream.on('error', kill('upstream error'))
  socket.on('error', kill('socket error'))
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[server] http+ws-proxy luistert op 0.0.0.0:${PORT}`)
  console.log('[server] GET /relay.json levert: ' + relayJson.replace(/\s+/g, ' '))
})

const shutdown = async () => {
  console.log('[server] afsluiten…')
  server.close()
  try { await relay.orbitdb.stop() } catch {}
  try { await relay.ipfs.stop() } catch {}
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
