# PWA / installeerbare app voor de Abundomy-dapp op IPFS — ontwerp & plan

**Datum:** 2026-09-10 · **Auteur:** pi (onderzoek/ontwerp, non-destructief)
**Bevat:** installatie-uitvoering van "kan de Pentecost-app ook op de abundomy-dapp?"
**Scope (beslist door Patrick):** installeerbare PWA **MET install-knop** · **geen domein-migratie** (blijft `167-233-171-25.sslip.io` / IPNS zoals nu).
**Status:** ontwerp alleen. Geen enkele wijziging live gezet. Geen push (fase B = apart, zie §7).

---

## 1. Korte beantwoord

**Ja.** De abundomy-dapp is technisch klaar om dezelfde PWA te worden als Pentecost/MyChat:
- **HTTPS** ✓ (`sslip.io` Let's Encrypt-cert op nginx).
- **Geen CSP** ✓ → `navigator.serviceWorker` / `link rel=manifest` worden níet geblokkeerd.
- **nginx `/app/` = `no-cache`** ✓ → manifest + sw.js + icoon worden **altijd vers** opgehaald van de IPNS-bundel (IPFS/immutable content is dus géén blokkade).
- **Bestaande deploy-pipeline** (`deploy.sh`: `vite build` → `ipfs add -r` → `ipfs name publish`) → PWA-bestanden erin droppen is **geen pipeline-wijziging**; ze "rijden mee".
- **Één nuance (al bevestigd) op de dapp:** er staat **geen** manifest/sw (beide 404, geen `link rel=manifest` in `index.html`). Dus nu is de dapp *niet* installeerbaar.

→ **Stap A (deze sessie-omvang):** dapp installeerbaar maken + echte install-knop. **~3 files + 1 edit**, nul infra-wijziging.
→ **Stap B (apart, niet nu):** Web Push ("ping als de app dicht is") — vereist een push-backend die abundomy nog niet heeft. Zie §7.

---

## 2. Huidige stand (live geverifieerd 2026-09-10, read-only)

| Onderdeel | Waarde |
|---|---|
| Publiek URL van de dapp | `https://167-233-171-25.sslip.io/app/` (via nginx→Kubo-gateway :8080→IPNS `k51qzi5uqu5…dbvv0yupu4`) |
| `manifest.json` / `sw.js` | **404** (niet aanwezig) |
| `link rel="manifest"` in `index.html` | **niet aanwezig** |
| CSP-header | **geen** (nginx serveert alleen `Cache-Control: no-cache`) |
| nginx `/app/` cache | `add_header Cache-Control "no-cache" always` (goed voor PWA) |
| Vite config | `root: 'web'`, `base: './'`, `outDir: '../dist-web'`, `publicDir` default = `web/public` |
| Bundel-naar-IPFS | `deploy.sh`: `dist-web/` → `BUNDLE/app/` → `ipfs add -rQ` → `ipfs name publish` (IPNS-key) |
| App-entry | `web/src/app.mjs` (`<script type="module" src="./src/app.mjs">`) |
| Ingelogd-UI | `#app-header` / `#view-home` (logo · saldo · avatar) |
| icoon-basis | `web/public/img/1CoinH_140x140.png` (140×140, RGBA/transparant); `favicon.ico` = slechts 16×16 (onvoldoende) |

---

## 3. Bestandslijst (wat er toe komt / erin veranderd)

Alle nieuwe PWA-bestanden gaan in **`web/public/`** → vite copy't ze 1-op-1 naar `dist-web/` → `deploy.sh` zet ze in `BUNDLE/app/` → ze worden live op `https://167-233-171-25.sslip.io/app/<bestand>`.

| # | Bestand | Type | Doel |
|---|---|---|---|
| 1 | `web/public/manifest.webmanifest` | **nieuw** | PWA-manifest (naam, icoon, scope, kleuren) |
| 2 | `web/public/sw.js` | **nieuw** | Service worker **mèt `fetch`-handler** (= vereist voor install-knop) + push/notificatie-stub (vast, zodat fase B géén SW-wijziging meer nodig heeft) |
| 3 | `web/public/img/pwa-icon-192.png` | **nieuw** | icoon 192×192 (square, met fone-safe padding) |
| 4 | `web/public/img/pwa-icon-512.png` | **nieuw** | icoon 512×512 (+ `purpose: "any maskable"`) |
| 5 | `web/index.html` | **1 edit** | `link rel=manifest` + `theme-color` + `apple-mobile-web-app-*` meta's |
| 6 | `web/src/app.mjs` | **1 edit** | SW-registratie + `beforeinstallprompt` → eigen **"Installeer Abundomy Money"-knop** |

**Geen** wijziging aan: nginx, `deploy.sh`, `vite.config.js`, backend, relay, IPNS.

---

## 4. De bestanden (concreet, klaar om te kopiëren)

### 4.1 `web/public/manifest.webmanifest`
```jsonc
{
  "name": "Abundomy Money",
  "short_name": "Abundomy",
  "description": "Gedecentraliseerde gemeenschapsmunt — vraag, stort en volg transacties.",
  "start_url": "./",            // relatief → /app/ (binnen scope)
  "scope": "./",                // /app/ ; de SPA die de SW bestuurt
  "display": "standalone",
  "orientation": "portrait",
  "background_color": "#1b1208", // = --background van de dapp (uit index.html)
  "theme_color": "#1b1208",
  "lang": "nl",
  "dir": "ltr",
  "icons": [
    { "src": "./img/pwa-icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any" },
    { "src": "./img/pwa-icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any" },
    { "src": "./img/pwa-icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any maskable" }
  ]
}
```
> **Let op:** `start_url`/`scope`/icoon-pad zijn **relatief** (`./`) omdat de bundel op de sub-pap `/app/` staat (vite `base:'./'`). Absolute `/`-paden zouden de content-site (nginx `/`) raken — fout.

### 4.2 `web/public/sw.js`  (mèt `fetch`-handler = sleutel tot de install-knop)
```js
/* Abundomy-dapp — service worker (2026-09-10).
   Minimale SW: (1) network-first pass-through + (2) push/notificatie-stub voor fase B.
   Geen caching van app-shell (content-addressed IPFS + nginx no-cache => altijd vers). */

// (1) install-knop-eisen: Chrome vraagt een SW met een 'fetch'-listener.
// network-first: probeer live (IPFS-vers), pas eventueel opvallen. Zonder cache
// = "altijd de newest IPNS-versie", in lijn met de dapp-filosofie.
self.addEventListener('fetch', (e) => {
  e.respondWith(fetch(e.request));
});

/* (2) Push/notificatie-skelet (fase B). Werkt pas als er ook een push-backend
   is die push-events met VAPID naar de abonnees stuurt (zie §7). Zonder backend
   doet dit niks — dus veilig om nu al te leggen. */
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = {}; }
  e.waitUntil(self.registration.showNotification(d.title || 'Abundomy Money', {
    body: d.body || 'Nieuw op Abundomy Money',
    icon: './img/pwa-icon-192.png',
    data: { url: d.url || './' },
    tag: 'abundomy'
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || './';
  e.waitUntil((async () => {
    const cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of cs) { await c.focus(); return; }
    await self.clients.openWindow(url);
  })());
});
```

### 4.3 Icoonten (`pwa-icon-192.png`, `pwa-icon-512.png`)
Bron `1CoinH_140x140.png` (transparant) → square + **solid background** + **safe-zone-padding** (voor maskable). `sips` (Mac, altijd aanwezig):
```bash
cd web/public/img
# solid background (Abundomy-donker #1b1208) + transparant erop compositten = square 512
# Stap-voor-stap met ImageMagick 'convert' is nauwkeuriger; minimale sips-versie:
sips -z 512 512 1CoinH_140x140.png --out pwa-icon-512.png   # schaal naar 512 (wordt wat zacht)
sips -z 192 192 1CoinH_140x140.png --out pwa-icon-192.png
```
> **Aanbevolen:** de 512 met een **vaste achtergrond** genereren (niet transparant), zodat Android maskable correct clippt en iOS op donkere home-screens niet zwart-zwart is. Dan evt. met ImageMagick: `convert … -background '#1b1208' -gravity center -extent 512x512 pwa-icon-512.png`. Voor **fase A** is transparant+`any` al genoeg om de install-knop te krijgen; maskable/solid is polish.

### 4.4 `web/index.html` — `head`-edit (binnen `<head>`, naast bestaande `link`s)
```html
<link rel="manifest" href="./manifest.webmanifest" />
<meta name="theme-color" content="#1b1208" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
<meta name="apple-mobile-web-app-title" content="Abundomy" />
<link rel="apple-touch-icon" href="./img/pwa-icon-192.png" />
```

### 4.5 `web/src/app.mjs` — SW-registratie + install-knop
Plaats vóór/bij de app-init (bijv. onder de bestaande boot-logic). Toont een eigen **"Installeer Abundomy Money"** knop die pas verschijnt zodra `beforeinstallprompt` firet:
```js
// --- PWA: service worker registreren (alleen https, buiten localhost) ---
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('./sw.js').catch(err => console.warn('SW-reg:', err));
}

// --- PWA: eigen install-knop via beforeinstallprompt ---
let _deferredInstall = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();              // eigen knop in plaats van de Chrome-banner
  _deferredInstall = e;
  showInstallButton();            // rendert een knop (bv. in #view-home of #app-header)
});
window.addEventListener('appinstalled', () => { _deferredInstall = null; /* knop weg */ });

function showInstallButton() {
  // In #view-home (ingelogd-UI) of als vlagging:
  const b = document.getElementById('installAppBtn') || (() => {
    const btn = document.createElement('button');
    btn.id = 'installAppBtn'; btn.className = 'login-button';
    btn.textContent = 'Installeer Abundomy Money';
    btn.addEventListener('click', onInstallClick);
    document.querySelector('#app-header .header-main')?.appendChild(btn)
      || document.body.appendChild(btn);
    return btn;
  })();
  b.style.display = '';
}
async function onInstallClick() {
  if (!_deferredInstall) return;
  _deferredInstall.prompt();
  await _deferredInstall.userChoice;
  _deferredInstall = null;
  document.getElementById('installAppBtn')?.remove();
}
// Verberg de knop als de app al geïnstalleerd is:
if (window.matchMedia('(display-mode: standalone)').matches) {
  document.getElementById('installAppBtn')?.remove();
}
```
> **Plaatsing knop:** in `#app-header` (ingelogd) zodat "Installeer" alleen voor echte gebruikers verschijnt; of als kleine chip in `#view-home`. Keuze is cosmetic — de logica werkt overal in de `/app/`-scope.

---

## 5. IPFS- / nginx-specifieke aandachtspunten

1. **Scope = `/app/`.** De SW bestuurt alleen URLs onder `/app/` (de dapp-SPA). De **content-site** op `/` (artikelen) valt **niet** binnen de scope — dat is juist goed: de SW raakt de content-site aan.
2. **IPFS/immutable + always-fresh.** nginx `/app/` = `no-cache` → browser haalt `manifest.webmanifest`/`sw.js`/icons na elke IPNS-redeploy vers op. De SW wordt door de browser zelf maximaal 24h gecached (standaard PWA-gedrag, acceptabel).
3. **Bestandsnaam.** Kies `manifest.webmanifest` (standaard) én voeg `manifest.json` als symlink/alias toe **alleen** als iets het vereist — anders 1 bestand (Chrome/Android accepteert `.webmanifest`).
4. **Relatieve paden** (vite `base:'./'` + sub-pap `/app/`) → alle `start_url`/icoen/`sw.js`-paden relativ (`./…`), níet `/…`.
5. **Icoon-afmetingen** voor de install-knop: Chrome vereist minimaal **192 + 512** (bestaande `1CoinH_140` is te klein → dus de 2 nieuwe icoonten). Maskable is optioneel polish.
6. **Domein-geenkeus (beslist):** we blijven op `167-233-171-25.sslip.io`. PWAs werken daar prima (HTTPS-valid). Eventueel latere upgrade naar `app.abundomy.com → PBFS2` (CertDax) blijft **mogelijk maar is nu expliciet uitgesloten.**

---

## 6. Test- en rollout-procedure (non-destructief vóór live)

1. **Lokaal builden** (geen IPFS-touch): `cd abundomy-dapp && npm run build:web` → controleer dat `dist-web/manifest.webmanifest`, `dist-web/sw.js`, `dist-web/img/pwa-icon-{192,512}.png` er liggen.
2. **Lokaal preview** over HTTPS (SW vereist secure context): `npx vite preview --host` of een lokaal https-proxy na `dist-web`; `https://…/` openen en:
   - DevTools → Application → Manifest/Service Workers: manifest geparst, SW geregistreerd, scope `/`.
   - Chrome toont de **install-knop** (of de `beforeinstallprompt`-banner).
   - Lighthouse → PWA-score (≥ 100 "installable").
3. **Goedkeuring Patrick.**
4. **Live**: bestaande `./deploy.sh` (`ipfs add` + `ipfs name publish` + cluster-replicatie). **Geen** nginx-wijziging. De dapp is meteen installeerbaar.
5. **Verificatie live:** `curl -I https://167-233-171-25.sslip.io/app/manifest.webmanifest` → 200 application/json; zelfde voor `sw.js` + iconen.

---

## 7. Fase B — Web Push ("ping als de app dicht is") — NAAST/OPVOLGER (niet nu)

De échte "app-waarde" van Pentecost is push-notificatie als de tab is dicht. Dat **vereist** een backend die abundomy nog niet heeft:

| Stuk | Pentecost/MyChat (bestaan) | Abundomy (nu) |
|---|---|---|
| VAPID-key | ja (`/opt/mychat-2fa`, `py_vapid`) | ❌ |
| Subscription-store | `2fa-service /api/2fa/push/...` | ❌ |
| Delivery | relay `notifyPush()` → 2fa-service | ❌ (weél `abundomy-mailer` :9100 = **e-mail** notificaties) |

**Opties (indien fase B ooit):**
- **B1 (aanbevolen):** hergebruik MyChat-pattn — een kleine `abundomy-push`-service (of uitbreiding van `abundomy-mailer` :9100) met een VAPID-key + een `push_subs`-tabel + `POST /api/push/notify` die web-push naar de endpoints stuurt. De dapp-abonneert zich via `PushManager.subscribe()` en stuurt de subscription naar die endpoint. **Eén VAPID-keypair kan beide origins (mychat + abundomy) dienen** omdat de browser de publieke key per-origine verifieert (geleverd via `/applicationserverkey` per host) — dus we kunnen dezelfde private key hergebruiken.
- Inspansing: ~1 dag. Gevolgen: nieuwe systemd-service + 1 extra nginx `location /api/push/` + datafile; IPFS/content onafgehaakt.
- De **SW-stubs** (push/notificatieclick) zitten al in §4.2, dus fase B hoeft **geen** SW-wijziging meer — alleen de backend toevoegen + `navigator.push`-abonnementscode in de dapp.

---

## 8. Rollback (per deel, onafhankelijk)

- **Stap A terugdraaien** = oude `index.html`/`app.mjs` terug + de PWA-bestanden uit `web/public/` weg + `npm run build:web` + `./deploy.sh`. De vorige IPFS-CID (deploy ontpint de oude pas na 48h) blijft t.i.d. beschikbaar; snelle rollback = redeploy voorgaande bundel (`git`-revert in de werkmap + deploy).
- **Kennislaag:** dit doc is **nieuw**; er is **geen** bestaande file gewijzigd tijdens het onderzoek.
- **Fase B (als ooit)** = `systemctl disable --now abundomy-push` + nginx `location /api/push/` weg + reload; SW-stubs blijven (doen dan niks).

---

## 9. Open keuzes (voor goedkeuring door Patrick)

1. **Icoon:** 192/512 uit `1CoinH_140` genereren (transparant, snel — genoeg voor install-knop) óf nette square met **vaste donkere achtergrond** (beter voor Android maskable + iOS). Standaard voorstel: **transparant nu, achtergrond-polish later.**
2. **Knop-plaats:** in `#app-header` (alleen ingelogd) óf als chip in `#view-home` óf beide. Standaard voorstel: `#app-header` (ingelogd).
3. **Fase B (web push)** nu tegelijk óf los? (Standaard: los, na stap A goedkeurd.)
