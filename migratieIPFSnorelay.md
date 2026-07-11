# Migratie: relay-loos / domein-loos (IPFS, geen reikiwereld.eu)

**Doel (door Patrick gesteld):** de Abundomy-dapp volledig loskoppelen van de relay
die via `app.reikiwereld.eu` liep. Geen relay-server, nergens. Geen afhankelijkheid van
het domein `reikiwereld.eu`. Een oplossing die Patrick zelf kan testen.

Datum samenvatting: 2026-06-04.

---

## 1. Hoe de situatie werd aangetroffen (oud)

- De browser-SPA verbond met een **relay-node** die draaide via `app.reikiwereld.eu`
  (`abundomy-relay.service`). Die relay deed de OrbitDB head-exchange én leverde blocks.
- De live-site draait **alleen via IPFS/IPNS** (zie [[abundomy-deploy-plan]]); de relay was
  daarmee de enige niet-IPFS, domein-gebonden infra in het datapad.
- De Hetzner-doos (`178.105.222.179`, voorheen geparkeerd) zou het publieke **anker** worden.

Kernbeperking die de architectuur stuurde: een **limited connection** (circuit-relay-v2)
kan **geen** floodsub of OrbitDB-sync dragen (`LimitedConnectionError`). De head-exchange
gebeurt via een direct `dialProtocol(peer, '/orbitdb/heads/<addr>')` over een *volledige*
(unlimited) verbinding — niet via pubsub-relaying.

---

## 2. Wat is veranderd / naar een nieuwe versie gebracht

### Op de Hetzner-anker-doos (`178.105.222.179`)
| Dienst | Oud → Nieuw | Toelichting |
|---|---|---|
| **Kubo (IPFS)** | 0.35.0 → **0.41.0** | 0.35 gaf SIGSEGV in bitswap (`newMessageFromProto`) bij pin; publiek blootgestelde node was kwetsbaar voor misvormde bitswap-berichten. |
| **Node.js** | — → **v24.16.0** | geïnstalleerd in `/usr/local/bin` voor de replicator. |
| **`ipfs.service`** | bestaand | Kubo-daemon, IPFS-pad `/mnt/HC_Volume_105912454/.ipfs`. |
| **`ipfs-cluster.service`** | nieuw | IPFS-Cluster (CRDT) voor pin-replicatie SER5 ↔ anker. |
| **`abundomy-anchor-replicator.service`** | **nieuw** | Altijd-aan OrbitDB-replicator (zie hieronder). Env: `/etc/abundomy-anchor-replicator.env`. |
| **nginx + certbot** | nieuw | Let's Encrypt-cert voor `178-105-222-179.sslip.io`; termineert **wss :443** → proxyt naar `127.0.0.1:4003` (replicator, plain ws). |
| **Bron** | — | `/opt/abundomy-dapp` (rsync van de repo). |

`sslip.io` levert gratis IP-gebaseerde DNS (`178-105-222-179.sslip.io` → `178.105.222.179`),
zodat we een geldig TLS-cert (wss) krijgen **zonder eigen domein**.

### In de repo (`abundomy-dapp/`)
- **`web/anchor-replicator.mjs`** (NIEUW) — altijd-aan OrbitDB-replicator (Helia v6 +
  OrbitDB v4 + floodsub + bitswap). Opent de stores op **naam** met `write:['*']`
  (→ deterministische adressen, geen manifest-fetch-crash), mirrort OrbitDB-blocks
  (dag-cbor/sha2-256) naar Kubo via RPC `block/put`. `routers:[]`, `blockBrokers:[bitswap()]`.
  Env: `ABUNDOMY_KUBO_RPC`, `ABUNDOMY_REPL_LISTEN=/ip4/0.0.0.0/tcp/4003/ws`,
  `ABUNDOMY_REPL_AUTOTLS=0`, `ABUNDOMY_BOOTSTRAP_ADDRS`, `ABUNDOMY_MIRROR`.
- **`web/src/ipfs-browser.mjs`** (herschreven) — `transports:[webSockets(), webTransport()]`,
  `addresses:{listen:[]}`, `routers:[]`, `blockBrokers:[bitswap()]`, floodsub.
  Circuit-relay verwijderd.
- **`web/public/relay.json`** (gewijzigd) — nu **replicator-only**:
  `addr = /dns4/178-105-222-179.sslip.io/tcp/443/wss/p2p/12D3KooWAdaFxcNwYqMNuQxWeS4wWSFhJA7cr7Xmos4csa1QD2Ug`.
  Anker + oude-relay-velden verwijderd (het anker miste blocks → intermittente bitswap-time-outs).
  Store-adressen: users `zdpuAqXy8…`, proposals `zdpuAySFaJs1…`, transactions `zdpuB3X7zKj5…`,
  lists `zdpuAkiEb45n…`, usersOld `zdpuAu1zSYC9…`.
- **`web/src/app.mjs`** — `dialRelay` (dialt relay.addr + evt. replicator), `resyncStores`
  bugfix (`a.split('/p2p/').pop()` i.p.v. `multiaddr().getPeerId()` — die methode bestaat
  niet in de gebundelde versie en wierp elke 20s "↻ resync-fout"), live-render via
  `db.events.on('update', …)` + periodieke `render()`/`resyncStores()`.
- **`deploy.sh`** — `relay.json` wordt nu **verbatim** gekopieerd (geen domein-herschrijving);
  stap 5b: cluster-pin nieuwe CID + anker-IPNS-publish via SSH.

---

## 3. Onderzocht en verworpen
- **Optie A — circuit-relay-v2 (browser via anker → replicator):** onmogelijk; limited
  connections dragen geen floodsub/OrbitDB-sync. Bewezen, verlaten.
- **`@libp2p/auto-tls` (`*.libp2p.direct`):** multiaddr-versie-skew (auto-tls@1.0.6 →
  multiaddr@12, libp2p@3 → multiaddr@13) → `supportedAddressesFilter` weigert alle adressen
  → "no public addresses". npm-override-poging mislukte. Verlaten t.g.v. sslip.io+certbot.
- **WebRTC-Direct (domein-loos):** verbindt wel, maar OrbitDB-sync faalt (CBOR-decode-fout in
  `sync.js`, verbinding valt ~30s weg). Verlaten.

**Gekozen eindoplossing:** `sslip.io` + nginx + certbot → **wss-replicator**. Domein-loos,
relay-loos.

---

## 4. Wat is geverifieerd (relay-loos werkt)
- Verse Node-probe (alléén wss → replicator, stores op adres) trok **alle 8 proposals +
  4 users** binnen ~4s via head-exchange. Domein-loos.
- Browser → replicator schrijf-propagatie bewezen (mirror-count loopt op).
- Replicator → browser live-propagatie bewezen (~2.5s, twee headless browsers).
- Live-data: 4 echte users — Patrick (id 1), AmsterdamBoomer (2), Teun van Sambeek (3),
  Sphinx (4). Proposals t/m #10 (8 uniek). Ghost-ids 13/37/38 = onschadelijke testresten.

---

## 5. Nog te doen / openstaand
- [ ] **`npm run deploy`** (IPNS-live) — NIET gedaan; de IPNS-bundel is nog niet vernieuwd.
      LET OP: `app.reikiwereld.eu` is het **oude** pad en wordt uitgefaseerd (zie §0/§7).
- [x] **Oude SER5-relay + mailer uitgeschakeld** (2026-06-04 's avonds): `abundomy-relay.service`
      en `abundomy-mailer.service` **gestopt én disabled**. Daarmee is de oude koppeling met
      reikiwereld.eu gekapt.
- [ ] **Mail op Hetzner** — laagste prioriteit (Patrick).
- [x] **OPEN BUG opgehelderd** — zie §6.

---

## 6. "Verzoek komt niet aan" — OPGEHELDERD (2026-06-04 nacht)
**Conclusie: het probleem zat in het OUDE pad / oude data, niet in het nieuwe systeem.**

- Read-only probe op het **primaire anker (Hetzner)** toont gezonde data: 8 proposals — inclusief
  Patricks verzoek aan AB (`pid=10 giver=2 receiver=1 "Patrick doet 22 verzoek aan AB"`) — en
  **AB (`AmsterdamBoomer`, id 2) staat op `useWhitelist=0`** (blacklist-modus, lege lijst) → AB
  hoort alle verzoeken te zien.
- Eerdere foute conclusie ("AB `useWhitelist=1` → verzoeken verborgen") kwam uit een **kopie van
  de OUDE SER5-relay-store**, die was **afgeweken** van het anker (daar stond nog `1`). Les: lees
  uitsluitend het **primaire anker**, nooit de oude relay-data. Zie [[architectuur-leidend]],
  [[hetzner-anker-infra]].
- Patrick heeft daarna in de browser (dev-server → Hetzner-replicator) bevestigd dat verzoeken
  **meteen en snel** binnenkomen. Nieuw pad werkt end-to-end.

**Naast-bevinding + fix:** white-/blacklist bewerken was kapot door twee niet-numerieke
`listId`-resten (`C1-…`, `C2-…`) die `Math.max` → `NaN` maakten in `addToList`. Gefixt in
`src/lists.mjs` (negeert niet-numerieke listId's) + regressietest; suite groen (47/47). Zie
[[list-edit-nan-bug]].

**Harde regel (na eerder data-incident):** NOOIT testdata naar de LIVE OrbitDB-stores
schrijven; uitsluitend read-only inspectie of een geïsoleerde test-store.

---

## 7. Doel voor de volgende sessie (door Patrick gesteld, 2026-06-05)
Een paar stappen terug nemen en het **oorspronkelijke doel** goed onderzoeken en implementeren:
een IPFS-gebaseerd platform **zoals het nu werkt**, maar met één belangrijk verschil — het moet
**zónder een relay** werken. De huidige `abundomy-anchor-replicator` is feitelijk nog een
server-side OrbitDB-proces waar browsers via wss op aansluiten; dat is wat Patrick wil
elimineren ten gunste van een echt relay-loos model (Hetzner-Kubo als puur anker in de swarm,
browsers peer-to-peer). Eerder verworpen sporen (zie §3: circuit-relay-v2, auto-tls,
WebRTC-Direct) opnieuw afwegen tegen dit doel. Begin volgende sessie met een nuchtere
herijking, niet meteen bouwen.
