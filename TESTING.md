# Abundomy — test- & productie-gereedheidsrunbook

Hoe je het hele systeem test "alsof we hierna in productie gaan". Volg deel A
(geautomatiseerd), dan deel B (handmatig, browser), dan deel C (generale repetitie).
Deel D is de eerlijke checklist met wat nog moet vóór écht productie.

Werkmap: `abundomy-dapp/`. Vereist: Node 24, `npm install` gedaan.

---

## A. Geautomatiseerde verificatie (≈1 min)

Draai op volgorde; alles moet groen zijn.

| Stap | Commando | Verwacht |
|---|---|---|
| 1. Rookproef | `npm run smoke` | `✅ ROOKPROEF GESLAAGD` (Helia + OrbitDB starten) |
| 2. Unit/integratie | `npm test` | `tests 46 / pass 46 / fail 0` |
| 3. Datamigratie *(optioneel/legacy)* | `npm run migrate` | `✅ … 6 transactions, 17 users, …` (idempotent) — niet gebruikt door de live instantie (die startte vers) |
| 4. Serverless betaling | `npm run poc` | alle go/no-go-checks ✅, `✅ PoC GESLAAGD` |
| 5. Fork-scan | `npm run scan:forks` | `✅ Geen forks — ledger gezond` |
| 6. Site bouwen | `npm run build:site` | `✅ 5 pagina's + 54 artikelen … (resterende PHP: 0)` |
| 7. App-smoke (browser) | `npm run build:web && npm run test:e2e` | `13/13 checks geslaagd` (CDP + systeem-`chromium`) |
| 8. Content-smoke (browser) | `npm run test:content` | `15/15 checks geslaagd` (taalwissel + download-teller) |
| 9. Site hosten | `npm run publish:site` | `✅ CONTENTSITE GEHOST` + stabiel `/ipns/<key>` |

Wat dit dekt: hash-keten == legacy (byte-identiek), decay/UBI-saldo-invarianten,
proposal→betaling→saldo, profielversleuteling, ondertekende identiteit, lijsten,
draagbare zelf-verifieerbare export, fork/double-spend-detectie, het booten van de
app- en content-bundel in een echte browser (vlag-taalwissel + tellers), en
content-addressed hosting met pin + IPNS.

**Stabiele-naam-check (productie-eis):** draai stap 7 twee keer; de `IPNS-naam`
moet identiek zijn. Anders verandert je publieke adres bij elke publicatie.

---

## B. Handmatige end-to-end (browser, 2 tabs)

Dit is de echte gebruikerservaring (serverless betaling tussen twee personen).

1. **Venster 1:** `npm run relay` — laat open. Schrijft `web/public/relay.json`.
2. **Venster 2:** `npm run dev` — open de Vite-URL in de browser.
3. **Tab A:** log in als gebruiker-ID **13**, klik *Verbinden*. Wacht tot de
   statusregel toont: `peers: ≥1 · pubsub-peers: ≥1 · users: 17 · transacties: 6`.
4. **Tab B** (nieuw tabblad, zelfde URL): log in als **14**, klik *Verbinden*.
   In het **relay-venster** moet je nu twee keer `• browser verbonden` zien.
5. **Tab A (13):** "Betaling aanvragen" → Van **14**, bedrag bv. 10 → *Verzoek versturen*.
   Relay-venster toont `• ⇄ proposal ontvangen: pid …`.
6. **Tab B (14):** onder "Openstaande verzoeken" verschijnt het verzoek → *Bevestig & betaal*.
7. **Beide tabs:** saldo van 13 stijgt ~10, van 14 daalt ~10 (zelfde getallen).
8. **Tab A:** *Exporteer mijn keten* → CSV-download (zelf-verifieerbaar bewijs).

> Belangrijk: open en *Verbind* beide tabs vóór je een verzoek maakt — een
> publicatie terwijl de tegenpartij offline is gaat verloren tot de volgende sync
> (auto-herverbinden vangt de relay-link op).

---

## C. Productie-generale repetitie

Simuleer productie zo dicht mogelijk, lokaal:

1. **Twee machines / browsers** i.p.v. twee tabs: beide naar dezelfde relay laten
   wijzen. Bevestig dat betalingen heen-en-weer repliceren.
2. **Herstart-bestendigheid:** stop de relay (`Ctrl+C`), start opnieuw. De relay
   houdt dezelfde peerId + data (`.abundomy-relay/`); tabs herverbinden vanzelf.
   Saldi/keten blijven kloppen.
3. **Hosting na herpublicatie:** wijzig iets in de contentsite, `npm run build:site`
   + `npm run publish:site`. Het CID verandert, de **IPNS-naam blijft gelijk** en
   wijst nu naar het nieuwe CID.
4. **Integriteit onder druk:** draai `npm run scan:forks` na meerdere betalingen →
   moet gezond blijven.

---

## D. Checklist vóór échte productie (eerlijke gaps)

Werkt lokaal/PoC, maar dit moet nog vóór publiek productie. **Niets hiervan is af.**

- [ ] **Relay publiek + WSS.** De relay luistert op `127.0.0.1/ws`. Browsers op
      een HTTPS-site mógen geen onbeveiligde `ws://` dialen → je hebt een publiek
      bereikbare host met **WSS** (TLS-cert + domein) nodig. Voor browser↔browser
      direct: WebRTC + een TURN/relay-server.
- [ ] **Hosting online houden.** IPNS lost nu lokaal/offline op; voor publieke
      resolutie moet de IPFS-node online zijn en het record via de DHT propageren —
      óf een remote pinning-dienst (Pinata/web3.storage, API-sleutels) toevoegen.
- [ ] **Schrijfrechten aanscherpen.** Stores staan nu op `write:['*']` (iedereen mag
      schrijven). Productie heeft per-gebruiker ondertekende schrijfregels nodig
      (de ondertekende pubkey-claim bestaat al, maar wordt nog niet als ACL afgedwongen).
- [ ] **Identiteitsbinding afdwingen.** `usersId ↔ identiteit` is nu een claim die
      niet tegen de legacy-data wordt gevalideerd — iedereen kan elke `usersId` claimen.
- [ ] **Community-sleutel beheren.** Nu één gedeeld geheim uit env/dev-default;
      echte sleuteldistributie + rotatie nodig.
- [ ] **Double-spend-resolutie.** Fork-detectie *detecteert* (bewijsbaar) maar lost
      niet op. Globale ordening via het optionele Qortal-anker is uitgesteld.
- [x] **E-mailnotificaties + verificatie** — gebouwd (`web/mailer.mjs`, `/api/email/*`).
- [x] **Site i18n + taalkiezer** — vlag-taalkiezer (68 talen) op site én app, client-side
      tx_NN-fill; keuze gedeeld via `localStorage`. (Server-side `set-language.php` verviel.)
- [x] **Gedeelde download-tellers** — `/api/downloads` + OrbitDB-store (boek per taal + demo).

---

## Scripts (overzicht)

`smoke` · `migrate` · `test` · `test:e2e` · `test:content` · `poc` · `relay` ·
`mailer` · `dev` · `build:web` · `build:site` · `publish:site` · `deploy` · `scan:forks`
