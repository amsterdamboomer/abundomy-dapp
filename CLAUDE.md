# Abundomy dapp

LAMP→IPFS migratieproject, Fase 5 bijna af.

## Altijd onthouden
- Stack: Helia v6 + OrbitDB v4 + floodsub (NIET gossipsub)
- Opslag: .abundomy-data/ (OrbitDB), .abundomy-ipfs/ (Helia blocks)
- Alle economische logica in src/ledger.mjs (pure functies, niet aanraken zonder tests)
- npm test moet altijd groen blijven

## Auth (naam+wachtwoord)
- LET OP: de **accountidentiteit (`pubkey`) wordt deterministisch uit de seed afgeleid**
  (`deriveAccountKey` in identity.mjs, Ed25519). NIET de OrbitDB-identiteit gebruiken —
  die is willekeurig + per-apparaat (browser-keystore) en dus NIET reproduceerbaar uit de
  seed → login/reset op een ander apparaat zou "dit is niet jouw account" geven.
  claim/auth/recovery worden met deze seed-sleutel ondertekend, niet met orbitdb.identity.
- Signup: willekeurige seed → keypair/identiteit; seed versleuteld in een keystore
  (AES-GCM, sleutel = PBKDF2(wachtwoord)) → opgeslagen als `auth` op het user-doc
- Login: keystore opzoeken op `usersUid` óf e-mail (versleuteld → ontsleutel) →
  openKeystore(wachtwoord) verifieert → ingelogd
- ÉÉN gedeelde node voor de hele SPA (`ensureSession()`, node-seed vast in localStorage).
  NIET terug naar een aparte gast-/sessie-node per login — dat gaf twee koude syncs en
  login-timeouts in de browser. De node-identiteit doet niet mee aan de beveiliging
  (ondertekening via deriveAccountKey), dus één node volstaat.
- Reset (optie 2): bij signup wordt de seed óók versleuteld onder een herstelcode
  (`recovery`-kluis, per e-mail verstuurd). Reset = e-mail + herstelcode → seed →
  rekeyAuth(nieuw wachtwoord). Serverloos; relay heeft de seed nooit.
- Alleen de eigenaar wijzigt/reset: keystore-update wordt door de eigen keypair
  ondertekend (`authSig`/`recoverySig`); wijzigen vereist het huidige wachtwoord, reset
  de herstelcode (beide leveren de seed → keypair)
- Bestanden: src/auth.mjs (keystore), src/identity.mjs (signup+authSig),
  web/src/app.mjs (signup/login), web/index.html

## Deploy
- `npm run deploy` (= deploy.sh) bouwt de SPA + bundelt content op `/` en app op `/app/`,
  voegt toe aan Kubo, pint en publiceert onder IPNS. LET OP: deploy.sh draait GEEN
  `build:site` → na een content-/artikel-/vlag-wijziging eerst `npm run build:site`.

## Content-site build (web/build-site.mjs → web/site-dist/)
- Rendert de PHP-content (5 hoofdpagina's + 54 `articles/*.php`) statisch voor `en`;
  vertaling blijft CLIENT-SIDE (elke pagina vult `#tx_NN`-spans uit `/json/<page>.json`).
- `$baseHref` → absoluut `/` (werkt op elke diepte, ook `/articles/`); alle geïnjecteerde
  paden absoluut. Vlag-taalkiezer (`#abLangFlag` + overlay) i.p.v. de dode 🌐; vlaggen uit
  `web/public/json/flags.json`. Per artikel `window.__abPageJson` (json-basename ≠ bestandsnaam).
- Extra bundel-assets die niet in de Abundomy-bron zitten: `web/site-extra/` (1-op-1 over
  de bundel-root), bv. `download/OneCoinHDemo.xlsx` (van abundomy.com gehaald).

## Test
- `npm test` — pure Node-suite (ledger/auth/identity/lists), moet altijd groen.
- `npm run test:e2e` — browser-smoke van de **app** (dist-web) via CDP + systeem-`chromium`.
  Vereist eerst `npm run build:web`.
- `npm run test:content` — browser-smoke van de **content-site** (site-dist): home + vlag-
  taalwissel + artikel-render + de download. Vereist eerst `npm run build:site`.
- Geen Playwright (steunt geen chromium op Ubuntu 26.04); geen relay/mailer/data. Snap-
  chromium kan NIET in /tmp of dot-mappen — profiel staat in een niet-verborgen $HOME-map.

## Nooit doen
- gossipsub installeren (interface-mismatch met libp2p v3)
- platte óf gehashte wachtwoorden opslaan (WEL toegestaan: een met het wachtwoord
  versleutelde keystore — AES-GCM + PBKDF2; het wachtwoord verlaat de client nooit)
- gevoelige profielvelden onversleuteld schrijven
