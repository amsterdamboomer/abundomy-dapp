# abundomy-dapp

> Decentralized version of the Abundomy community currency (formerly *1CoinH*): a
> serverless money app **and** content site running on **IPFS (Helia)** with
> **OrbitDB** instead of a SQL database. *(README in Dutch — code & docs are Dutch.)*

Gedecentraliseerde herbouw van de Abundomy-gemeenschapsmunt (het oude `1CoinH`,
PHP/MySQL web2). Alles draait **serverloos**: identiteit via een sleutelpaar, data in
**OrbitDB**, gehost op **IPFS** met een stabiele **IPNS**-naam. Geen centrale database,
geen accountserver.

**🌐 Live:** <https://167-233-171-25.sslip.io/app/ content-site op `/`, de money-app op `/app/`.

---

## Wat zit erin

**Money-app (browser-SPA, `web/`)** — Helia v6 + OrbitDB v4 + floodsub, volledig client-side:
- Identiteit & auth: een seed-afgeleid Ed25519-sleutelpaar; de seed staat versleuteld in
  een met het wachtwoord beveiligde keystore (AES-GCM + PBKDF2). Het wachtwoord verlaat
  de client nooit; er wordt **geen** plat/gehasht wachtwoord opgeslagen.
- E-mailverificatie (uniek adres), wachtwoord wijzigen, en serverloze reset via een
  per-e-mail verstuurde herstelcode.
- Ledger met decay/basisinkomen, betaalverzoeken → betalingen, transactie-overzicht
  met berekening-paneel en detailweergave, PDF/CSV-export.
- Profiel (incl. pasfoto), en blok-/witte-lijst tegen ongewenste verzoeken.

**Content-site (statische build, `web/build-site.mjs` → `web/site-dist/`)**:
- De PHP-content (5 hoofdpagina's + 54 artikelen) wordt statisch gerenderd; vertaling
  blijft **client-side** (elke pagina vult `tx_NN`-spans uit `/json/<page>.json`).
- **68-talen vlag-taalkiezer** (ronde landvlaggen, zoekbare taalpagina) — dezelfde keuze
  reist mee tussen site en app via één `localStorage`-sleutel.
- Boek-download per taal + gedeelde **download-tellers**.

**Altijd-aan node (`web/relay.mjs` + `web/mailer.mjs`)**:
- `relay` — libp2p/WebSocket-relay + OrbitDB-seed waarmee browsers repliceren.
- `mailer` — verstuurt notificaties en draait de `/api/*`-laag (e-mailverificatie en de
  gedeelde download-teller `abundomy-downloads`) achter nginx.

## Architectuur in het kort
```
browser ── floodsub/websocket ──> relay (Helia + OrbitDB seed)
   │                                  ▲
   │  /api/* (nginx)                  │ replicatie
   ▼                                  │
 mailer (SMTP + OrbitDB stores) ──────┘
   ▲
   └── IPFS-gateway (Kubo) serveert de gebundelde content + app onder één IPNS-naam
```

## Tech-stack
Helia v6 · OrbitDB v4 · libp2p (floodsub — **niet** gossipsub) · Vite (SPA-build) ·
Web Crypto (Ed25519, AES-GCM, PBKDF2) · Node `node:test` · Kubo-gateway + IPNS.

## Scripts
| Commando | Wat |
|---|---|
| `npm test` | validatietests (ledger/auth/identity/lists/crypto/export/forks) — **46/46** |
| `npm run dev` | start de browser-SPA (Vite) — draai eerst `npm run relay` |
| `npm run relay` | relay/seed-node voor de SPA (schrijft `web/public/relay.json`) |
| `npm run mailer` | mailer + `/api/*` (e-mailverificatie + download-teller) |
| `npm run build:web` | bouw de SPA → `dist-web/` |
| `npm run build:site` | genereer de content-site (incl. artikelen) → `web/site-dist/` |
| `npm run deploy` | bouw + bundel (content op `/`, app op `/app/`) → IPFS-add/pin/IPNS |
| `npm run test:e2e` | browser-smoke van de **app** via CDP + systeem-`chromium` |
| `npm run test:content` | browser-smoke van de **content-site** (incl. taalwissel + teller) |
| `npm run scan:forks` | scan de ledger op forks/double-spends |
| `npm run migrate` | *(optioneel/legacy)* SQL-dump → OrbitDB; de live instantie startte vers |

## Lokaal draaien (2 vensters)
```bash
npm install
npm run relay          # venster 1 — laat open
npm run dev            # venster 2 — open de getoonde URL
```
Open een tweede tab om als andere gebruiker een betaling aan te vragen en te bevestigen;
replicatie loopt via de relay.

## Deploy
`npm run deploy` bouwt de SPA, stelt de bundel samen (content op `/`, app op `/app/`),
voegt toe aan de lokale Kubo-node, pint en publiceert onder de IPNS-sleutel. **Let op:**
deploy draait géén `build:site` — na een content-/artikel-/teller-wijziging eerst
`npm run build:site`. Een wijziging in `web/mailer.mjs` vereist een herstart van de
`abundomy-mailer`-service.

## Waarom floodsub (niet gossipsub)
De nieuwste gossipsub hangt nog aan `@libp2p/interface@2`, terwijl deze stack op
interface 3 zit; die mismatch brak alle replicatie. Floodsub is fire-and-forget en
werkt hier betrouwbaar voor het aantal peers van deze gemeenschap.

## Beveiliging
Geen platte of gehashte wachtwoorden — alleen een met het wachtwoord versleutelde
keystore (AES-GCM + PBKDF2). Gevoelige profielvelden worden versleuteld opgeslagen.
Secrets (SMTP) komen uit een lokale, niet-gecommitte env (zie `web/mailer.env.example`).

## Tests
Zie [`TESTING.md`](TESTING.md) voor het volledige runbook (geautomatiseerd + handmatig +
generale repetitie). Kort: `npm test` (Node-suite) · `npm run test:e2e` (app-smoke,
vereist `build:web`) · `npm run test:content` (content-smoke, vereist `build:site`).

## Licentie
GNU General Public License v3.0 of later — zie [`LICENSE`](LICENSE).
Je mag dit gebruiken, aanpassen en verspreiden onder dezelfde voorwaarden; afgeleide
werken moeten ook onder de GPL beschikbaar blijven.
