/**
 * PWA-laag voor de Abundomy-dapp (fase A — install-knop). Zie:
 *   docs/pwa-ontwerp-install-app-2026-09-10.md
 *
 * Bewust als apart module (niet in app.mjs): isoleert de PWA-concerns van de
 * app-bootlogica, zodat een PWA-fout de kern-app nooit kan breken. Vite bundelt
 * het mee via een aparte <script type="module"> in index.html.
 *
 * Twee dingen:
 *   1. service worker registreren (vereist voor de install-knop op https).
 *   2. eigen "Installeer Abundomy Money"-knop via beforeinstallprompt — verschijnt
 *     in #app-header (ingelogd-UI). In standalone-mode (al geïnstalleerd) is de
 *     knop afwezig.
 *
 * Fase B (web push) gebruikt de bestaande sw.js-stub; deze module hoort er niet
 * bij en raakt de push-logica niet aan.
 */

// --- 1. service worker registreren (alleen op een secure context) ---
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err) => {
       // Stil falen: de app werkt gewoon zonder PWA; alleen geen install-knop.
      console.warn('[pwa] SW-registratie mislukt:', err);
    });
  });
}

// --- 2. eigen install-knop via beforeinstallprompt ---
let _deferredInstall = null;
let _installBtn = null;

function showInstallButton() {
  if (_installBtn) { _installBtn.style.display = ''; return; }

  // Plaats in #app-header .header-main (ingelogd-UI); fallback naar body.
  const host =
      document.querySelector('#app-header .header-main') ||
      document.getElementById('view-home') ||
      document.body;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.id = 'installAppBtn';
  btn.className = 'login-button';
  btn.textContent = 'Installeer Abundomy Money';
  btn.title = 'Installeer Abundomy Money op je apparaat';
  // Klein inline-styling zodat de knop zichtbaar is zonder een css-bestand te raken.
  btn.style.marginTop = '0.5rem';
  btn.style.width = '100%';
  btn.addEventListener('click', onInstallClick);
  host.appendChild(btn);
  _installBtn = btn;
}

async function onInstallClick() {
  if (!_deferredInstall) return;
  const prompt = _deferredInstall;
  _deferredInstall = null;
  await prompt.prompt(); // outcome 'accepted'/'dismissed' — geen verdere actie
  removeInstallButton();
}

function removeInstallButton() {
  if (_installBtn) {
    _installBtn.remove();
    _installBtn = null;
  }
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); // eigen knop in plaats van de browser-banner
  _deferredInstall = e;
  showInstallButton();
});

window.addEventListener('appinstalled', () => {
  _deferredInstall = null;
  removeInstallButton();
});

// Al geïnstalleerd (standalone) => geen knop tonen.
if (window.matchMedia('(display-mode: standalone)').matches) {
  removeInstallButton();
}
