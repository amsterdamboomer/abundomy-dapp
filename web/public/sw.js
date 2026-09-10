/* Abundomy-dapp — service worker (2026-09-10, PWA fase A).
   Zie: docs/pwa-ontwerp-install-app-2026-09-10.md

   Twee taken:
   (1) install-knop = vereist een SW met een 'fetch'-listener.
   (2) push/notify-stub (fase B-skelet; doet nu niks zonder push-backend).

   Geen caching: content-addressed IPFS (IPNS) + nginx /app/ = no-cache =>
   de app is altijd de nieuwste versie. Dat is bewust (dapp-filosofie) en
   verandert het runtime-gedrag niet: alles is network-first doorgeven. */

// (1) network-first doorgeven: probeer altijd live, geen cache-staleness.
self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});

// --- Fase B: web-push skelet. Werkt pas als er een push-backend is die
// push-events met VAPID naar de subscriptions stuurt. Zonder backend doet
// dit niks => veilig om nu al te leggen (fase B heeft dan geen SW-wijziging).
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) { data = {}; }
  event.waitUntil(self.registration.showNotification(data.title || 'Abundomy Money', {
    body:  data.body || 'Nieuw op Abundomy Money',
    icon:  './img/pwa-icon-192.png',
    badge: './img/pwa-icon-192.png',
    data:  { url: data.url || './' },
    tag:   'abundomy',
   }));
});

// Klik op een push-notitie -> bestaande tab actief, anders nieuwe openen.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || './';
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of clients) { await c.focus(); return; }
    await self.clients.openWindow(url);
   })());
});
