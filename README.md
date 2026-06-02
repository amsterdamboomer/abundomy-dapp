# abundomy-dapp

Gedecentraliseerde versie van de Abundomy-gemeenschapsmunt (`1CoinH`): gehost op
**IPFS (Helia)** met **OrbitDB** als vervanging voor MySQL. Volledig serverless,
identiteit via sleutelpaar.

Zie [`../PLAN.md`](../PLAN.md) voor de architectuur en het gefaseerde plan.

## Locatie
Project staat op APFS: `~/Projecten/AbundomyWEB` (verplaatst van de 500GB exFAT-schijf,
die native modules en LevelDB-locking brak). OrbitDB's standaard LevelDB-opslag werkt
hier gewoon. Lokale data komt in `.abundomy-data/` (genegeerd door git).

## Scripts
- `npm run smoke` — Helia + OrbitDB lokaal opstarten, schrijven en lezen (rookproef)
- `npm run migrate` — `../1CoinH_24_05_2026.sql` → OrbitDB importeren (versleuteld)
- `npm run poc` — Fase 3 PoC: serverless betaling end-to-end tussen twee lokale peers
- `npm run relay` — relay/seed-node voor de browser-SPA (laat open in een venster)
- `npm run dev` — start de browser-SPA (Vite dev server) — eerst `npm run relay`
- `npm run build:web` — bouw de SPA naar `dist-web/`
- `npm run build:site` — genereer de statische Abundomy-contentsite → `web/site-dist/`
- `npm run publish:site` — publiceer `web/site-dist/` naar IPFS: pin + stabiele IPNS-naam
- `npm run scan:forks` — scan de lokale ledger op forks/double-spends (Fase 5)
- `npm test` — validatietests (`node:test`): hash-replay, saldo-invarianten, betalingen, forks

## Browser-SPA gebruiken
1. `npm run relay` (venster 1) — seedt de data, schrijft `web/public/relay.json`.
2. `npm run dev` (venster 2) — open de getoonde URL.
3. Log in met een gebruikers-ID (bv. 13). Open een tweede tab als 14 om een betaling
   aan te vragen (als 13) en te bevestigen (als 14). Replicatie loopt via de relay.

## Status
Fase 4 — datafundering + **browser-SPA af**: profielversleuteling (community-sleutel),
`users_old` gemigreerd, signup + ondertekende pubkey-claim, black/whitelist,
zelf-verifieerbare keten-export, en een Vite-SPA (`web/`) die de hele portable kern
in de browser draait via een WebSocket-relay. `npm test` = 25/25; `npm run build:web`
bouwt schoon. De live in-browser runtime vereist een echte browser om te testen.

De Abundomy-contentsite staat statisch op IPFS met pin + **stabiele IPNS-naam**
(`npm run build:site && npm run publish:site`; IPFS-native, geen Qortal). Fase 5:
fork-detectie + hosting **af**; resteert alleen het optionele Qortal-anker
(uitgesteld). Fase 4-restant: e-mailnotificaties.

Pubsub is **floodsub** (niet gossipsub): de nieuwste gossipsub hangt nog aan
`@libp2p/interface@2` terwijl deze stack op interface 3 zit — die mismatch brak alle
replicatie. Zie `PLAN.md` §4.
