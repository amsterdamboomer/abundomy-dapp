#!/bin/bash
# abundomy-patch-guard.sh — controleert vóór elke servicestart of de OrbitDB-patch nog
# in node_modules zit, en brengt hem zo nodig opnieuw aan.
#
# WAAROM. @orbitdb/core 4.0.0 stuurt bij een head-uitwisseling elke head als aparte
# stream.send() over een libp2p BYTE-stream. Bij 2+ heads komen ze aaneengeplakt binnen en
# faalt Entry.decode met "CBOR decode error: too many terminals". De patch splitst de
# ontvangen bytes op CBOR-grenzen. Zonder patch wordt de peer uit de sync-set gegooid →
# de catch-up van de betrokken store is stuk, voor élke peer. Dat faalt STIL: de app
# blijft werken (live pubsub decodeert één entry per bericht), dus het viel de vorige keer
# pas na weken op — 45.000 logregels later.
#
# Op SER5 zet `postinstall: patch-package` de patch vanzelf terug. Op PBFS2 staat geen git
# en geen npm-workflow: daar is de patch met de hand aangebracht en gooit één `npm install`
# hem stil weg. Vandaar deze guard.
#
# KEUZE BIJ ONHERSTELBAAR FALEN: de service start alsnog (exit 0), maar er gaat een mail
# naar bflogs@. Ongepatcht draaien is een DEGRADATIE (head-catch-up bij meerdere heads),
# geen datacorruptie — de service weigeren te starten zou van een stille degradatie een
# harde storing maken (mailer plat = geen signup/verificatie). Liever luid degraded dan
# stil kapot, en liever luid degraded dan onnodig plat.
#
# Gebruik (als ExecStartPre, draait als de service-user):
#   /usr/local/bin/abundomy-patch-guard.sh /opt/abundomy-dapp
set -uo pipefail

APP_DIR="${1:-/opt/abundomy-dapp}"
TARGET="$APP_DIR/node_modules/@orbitdb/core/src/sync.js"
PATCH="$APP_DIR/patches/@orbitdb+core+4.0.0.patch"
MAILTO="${ABUNDOMY_ALERT_MAIL:-bflogs@brainfusion.nl}"
HOST="$(hostname)"

# De patch introduceert splitEntries() — twee keer in het bestand (definitie + aanroep).
# grep -c geeft "0" én exitcode 1 bij nul treffers; `|| true` houdt set -o pipefail rustig.
patched() {
  local n
  n=$(grep -c 'splitEntries' "$TARGET" 2>/dev/null || true)
  [ "${n:-0}" -ge 2 ]
}

alert() {
  echo "PATCH-GUARD ALARM op $HOST: $1" >&2
  command -v mail >/dev/null 2>&1 && \
    echo "$1

Machine : $HOST
App-dir : $APP_DIR
Bestand : $TARGET
Patch   : $PATCH

De service is TOCH gestart, maar draait mogelijk ONGEPATCHT. Gevolg: de OrbitDB-head-
uitwisseling faalt zodra een store meer dan één head heeft, en de catch-up van die store
is stuk voor elke peer — dit faalt STIL. Herstel handmatig:

  cd $APP_DIR && patch -p1 --forward < '$PATCH'
  systemctl restart abundomy-mailer abundomy-anchor-replicator
" | mail -s "[ABUNDOMY] OrbitDB-patch weg op $HOST" "$MAILTO" 2>/dev/null
}

if [ ! -f "$TARGET" ]; then
  alert "sync.js bestaat niet — is node_modules weg of verplaatst?"
  exit 0
fi

if patched; then
  echo "patch-guard: OrbitDB-patch aanwezig ✓"
  exit 0
fi

echo "patch-guard: PATCH WEG uit $TARGET — opnieuw aanbrengen…" >&2

if [ ! -f "$PATCH" ]; then
  alert "de patch is weg uit node_modules ÉN het patchbestand ontbreekt — kan niet herstellen."
  exit 0
fi

# --forward: een al toegepaste patch wordt overgeslagen i.p.v. omgekeerd toegepast.
if patch -p1 --forward --silent -d "$APP_DIR" < "$PATCH" && patched; then
  echo "patch-guard: patch opnieuw aangebracht ✓"
  command -v mail >/dev/null 2>&1 && \
    echo "De OrbitDB-patch was verdwenen uit $TARGET (waarschijnlijk door een npm install)
en is door de guard automatisch opnieuw aangebracht. De service is normaal gestart.
Geen actie nodig — wel het onderzoeken waard wat de patch heeft weggegooid." \
    | mail -s "[ABUNDOMY] OrbitDB-patch automatisch hersteld op $HOST" "$MAILTO" 2>/dev/null
  exit 0
fi

alert "herstel MISLUKT — 'patch -p1 --forward' liep vast of het resultaat is nog ongepatcht."
exit 0
