# Taalspecifieke pagina's — hoe worden die "gepublished"?

> Korte antwoord: **er worden GEEN aparte pagina's per taal gepubliceerd.** Er is
> één Engelse basis-build die naar IPFS gaat; de vertaling gebeurt **100% dynamisch
> in de browser** (client-side) door tekst uit JSON-woordenboeken te wisselen —
> zónder herladen en zónder per-taal HTML-bestanden.

Dit document beschrijft beide i18n-systemen in het project, hoe ze publiceren, en wat
je moet doen om een taal of string toe te voegen.

---

## TL;DR

| | Content-/marketingsite | Money-app (SPA) |
|---|---|---|
| Geserveerd op | `/` (`web/site-dist/`) | `/app/` (`web/dist-web/`) |
| Bron | `web/build-site.mjs` (rendert PHP uit `../Abundomy/`) | `web/index.html` + `web/src/app.mjs` |
| Vertaalmechanisme | `#tx_NN`-spans → `el.innerHTML` uit JSON | `data-i18n="KEY"` → `t(key)` uit JSON |
| Woordenboek | `/json/<pagina>.json` (één per pagina) | `/json/app-i18n.json` (één groot bestand) |
| JSON-vorm | `{ taal: { tx_01: "<html>", … } }` | `{ taal: { KEY: "tekst", … } }` |
| Aantal talen | 68 | 69 |
| Taal-opslag | `localStorage['abundomy-lang']` | **zelfde** `localStorage['abundomy-lang']` |
| Per-taal HTML? | **Nee** — 1 Engelse build | **Nee** — 1 SPA |
| Dynamisch? | **Ja, client-side, geen reload** | **Ja, client-side, geen reload** |

Beide systemen delen bewust dezelfde `abundomy-lang`-sleutel, zodat je taalkeuze
meereist tussen de marketingsite en de app.

---

## 1. Content-/marketingsite (`/`)

### Wat er gepubliceerd wordt
`npm run build:site` draait `web/build-site.mjs`. Dat:
1. Rendert de PHP-bron uit `../Abundomy/` **één keer voor `en`** naar statische HTML
   (`renderPhp` lost includes/echoes op en stript de DB/PHP-logica).
2. Kopieert de asset-mappen (`css img json font articles download`) 1-op-1 mee.
3. Injecteert een client-side taalkiezer (`injectSwitcher`).

Output: `web/site-dist/` — **Engelse HTML + de JSON-woordenboeken als statische assets.**
Er is dus precies één `index.html`, één `community.html`, enz. — niet één per taal.

### Hoe de vertaling werkt (runtime, in de browser)
- Elke vertaalbare tekst staat in een element met een id `tx_NN`, met het **Engels
  inline als fallback** (zodat de pagina ook zonder JS leesbaar is).
- De taalkeuze zit in `window.__lang` (uit `localStorage['abundomy-lang']`, default `en`),
  gezet door een vroeg head-script (`HEAD_I18N` in `build-site.mjs`).
- Bij een taalwissel roept de vlag-knop `window.__abSetLang(code)` aan. Die:
  ```js
  fetch('/json/' + page + '.json')        // page = __abPageJson of de bestandsnaam
    .then(r => r.json())
    .then(d => {
      const ct = d[code] || d['en'] || {}  // woordenboek voor die taal
      for (const k in ct) {                // k = "tx_01", "tx_02", …
        const el = document.getElementById(k)
        if (el) el.innerHTML = ct[k]       // tekst vervangen, GEEN reload
      }
    })
  ```
- Daarna: `<html lang>`/`dir` bijwerken (RTL via `RTL_LANGS`), de vlag opnieuw tekenen,
  en het boek-cover/PDF per taal wisselen (`__abUpdateBook` via `BOOK_LIST`).

### De JSON-woordenboeken
- Per pagina één bestand: `index.json`, `community.json`, `articleNN.json`, … in
  `../Abundomy/json/` (en mee-gekopieerd naar `site-dist/json/`).
- Vorm: `{ "ah": { "tx_01": "...", ... }, "ar": { ... }, ..., "en": { ... } }` — 68 talen.
- Artikel-readers kunnen een **afwijkende** json-basename hebben; die wordt vastgelegd
  via `window.__abPageJson` (door `injectSwitcher` uit de bron-`fetch` gehaald).

### De taalkiezer
- Ronde landvlag rechtsboven (`#abLangFlag`) vervangt het dode 🌐-icoon.
- Klik opent een overlay (`#abLangOverlay`) met zoekveld + vlaggenlijst (68 talen uit
  de `LANGUAGES`-map). Vlaggen komen uit `/json/flags.json` (1-op-1 het originele
  `getFlagSVG`), gekopieerd uit `web/public/json/flags.json`.

---

## 2. Money-app / SPA (`/app/`)

- Vertaalbare elementen hebben `data-i18n="KEY"` (of worden in code via `t(key)` gevuld).
- `t(key)` (in `i18n.mjs`) = `cur[key] ?? en[key] ?? key` — eigen taal, anders Engels,
  anders de sleutel zelf als laatste redmiddel.
- Woordenboek: **één** bestand `web/public/json/app-i18n.json`, vorm
  `{ taal: { KEY: waarde } }`. Nu 69 talen, ±341 sleutels in `en`.
- Ook hier: dynamisch client-side, taalkeuze in dezelfde `localStorage['abundomy-lang']`.
- De PDF-export (`printStatement` in `app.mjs`) gebruikt dezelfde `t(key)`, dus het
  transactie-overzicht is óók meertalig.

---

## 3. Publiceren / deployen

```
npm run deploy         # bouwt content (build:site) + SPA (build:web), bundelt / + /app/,
                       # → Kubo add, pin, IPNS publish, repliceer naar Hetzner-anker
```

`npm run deploy` (= `deploy.sh`) bouwt **zowel de content-site (`build:site`) als de SPA
(`build:web`)** in stap 1 — een content-/artikel-/vlag-/page-JSON-wijziging komt dus
automatisch mee, je hoeft niets handmatig vooraf te bouwen. (Wil je losse builds:
`npm run build:site` → `web/site-dist/`, `npm run build:web` → `web/dist-web/`.)
`deploy.sh --no-build` slaat beide builds over en vereist een bestaande `site-dist/`.

Stabiel gebruikersadres: `https://178-105-222-179.sslip.io/app/` (Hetzner Kubo-gateway
op IPNS, altijd de laatste deploy). Content óók op `/`.

---

## 4. Een taal of string toevoegen

**Nieuwe string op de contentsite:** voeg een `tx_NN`-span (met Engelse fallback) toe in
de PHP-bron én de sleutel in álle taal-objecten van die `…/json/<pagina>.json`. Dan
`npm run deploy` (bouwt de site zelf).

**Nieuwe string in de app:** sleutel + waarde toevoegen aan **minstens** `en` (fallback)
en `ne` (Nederlands) in `app-i18n.json`; idealiter alle 69 talen (zie de
`i18n-specialist`-agent). Dan `npm run deploy`.

**Nieuwe taal:** code toevoegen aan de `LANGUAGES`-map in `build-site.mjs` (content) en/of
aan `app-i18n.json` (app), het woordenboek-object per pagina/sleutels vullen, en een vlag
in `flags.json` zorgen. Eventueel RTL-code in `RTL_LANGS`.

> **Referentie — eigen, niet-standaard taalcodes.** Het project gebruikt een eigen
> schema, géén ISO 639 (bv. `ne` = **Nederlands**, niet Nepali; Nepali = `np`). Dit is
> bewust niet "op te lossen" door te hernoemen: de codes zijn de sleutels in de
> page-JSON-woordenboeken (die in de **bron** `../Abundomy/json/` staan en we niet
> wijzigen), in `app-i18n.json`, in `flags.json`, én in de gedeelde
> `localStorage['abundomy-lang']` — hernoemen zou opgeslagen taalkeuzes en de bron
> breken. De **gezaghebbende betekenis van elke code** staat dus op één plek: de
> `LANGUAGES`-map in `web/build-site.mjs` (code → volledige taalnaam). Vertaal of map
> nooit op de code zelf, maar lees daar wat de code betekent.

---

## 4b. VEREISTE: Engels is de verplichte fallback

**Harde voorwaarde:** lukt de taalselectie niet, of ontbreekt een string in de gekozen
taal, dan MOET Engels de standaard zijn — voor de **hele content-site én de dapp**
(de PDF inbegrepen). Een gebruiker mag nooit een kale sleutel, lege tekst of
half-vertaald scherm zien waar Engels beschikbaar is. (Engels is de enige altijd-volledige
taal; alle 68/69 talen zijn afgeleiden.)

Deze fallback-keten zit op elk punt en moet bij élke i18n-wijziging bewaard blijven:

- **Dapp** (`web/src/i18n.mjs`):
  - `t(key) = cur[key] ?? en[key] ?? key` — per-sleutel terugval naar Engels.
  - `setLang(code)` → `'en'` als er geen woordenboek voor `code` is.
  - `detectDefaultLang()` / `loadI18n()` → `'en'` als de browsertaal/keuze niet matcht.
- **Content-site** (`web/build-site.mjs` + bron `../Abundomy/*.php`):
  - elke pagina-fill: `const content = data[currentLang] || data['en']`.
  - taalwissel `__abSetLang`: `var ct = d[code] || d['en'] || {}`.
  - boek-cover/PDF + sociale links: `…[lang] || …['en']`.
  - extra vangnet: het **Engels staat inline** in de `tx_NN`-spans, dus zelfs als de
    JSON-fetch faalt, blijft de pagina leesbaar in het Engels.

> Bij een nieuwe pagina, fill-script of i18n-helper: behoud altijd de `|| data['en']` /
> `?? en[key]`-tak. Verwijder die nooit "om op te schonen" — dan breekt deze vereiste.

Geverifieerd 2026-06-07: alle 5 hoofdpagina's + 54 artikelen hebben de en-fallback; de
dapp idem. Het is dus een te **bewaken guardrail**, geen openstaande fix.

## 5. Veelgestelde vraag: "is het dynamisch of pre-rendered per taal?"

**Dynamisch.** Eén Engelse build → IPFS; de browser haalt het taalwoordenboek op en
wisselt de tekst ter plekke (geen reload, geen per-taal-URL, geen per-taal-bestand).
Voordeel: een taal toevoegen of corrigeren = alleen JSON wijzigen, geen 68× pagina's
herbouwen. Nadeel: de niet-Engelse tekst is pas zichtbaar nadat JS draait (de Engelse
fallback staat wél direct inline in de HTML, dus de pagina is nooit leeg en blijft
indexeerbaar in het Engels).
