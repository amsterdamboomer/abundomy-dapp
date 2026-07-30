#!/usr/bin/env bash
#
# deploy.sh — publiceer de volledige Abundomy-omgeving naar de lokale Kubo-node.
#
# Bundel-structuur (één IPFS-publicatie, géén web2.0-afhankelijkheden):
#   /            → de statische content-site (web/site-dist: home, base, projects, education, community)
#   /app/        → de SPA (dist-web, gebouwd met vite base './', porteerbaar)
#   /app/relay.json → publiek wss-adres van de relay (de SPA haalt 'm relatief op)
#
# Stappen:
#   1. build content-site (build:site) + SPA (vite-build) — tenzij --no-build
#   2. publieke relay.json in dist-web (komt in /app/relay.json terecht)
#   3. bundel samenstellen: content op /, SPA op /app/
#   4. ipfs add + pin → nieuwe CID
#   5. ipfs name publish onder de IPNS-sleutel (DNSLink/DNS blijven ongemoeid)
#   5b. repliceer naar het Hetzner-anker (IPFS-Cluster) + laat het anker mee-publishen
#       (afgeschermd: ontbreekt het cluster/anker, dan gaat de deploy gewoon door)
#   6. de vorige CID ontpinnen
#
# Vereist: draaiende Kubo-daemon (ipfs.service) en de IPNS-sleutel (ABUNDOMY_IPNS_KEY).
# Wijzigt NIETS aan DNS, nginx of de live OrbitDB-data — alleen welke versie live is.
# Schrijft uitsluitend binnen abundomy-dapp/ (build-output); raakt geen bron-directories.
#
# Gebruik:  npm run deploy        of   bash deploy.sh [--no-build]
set -euo pipefail

DOMAIN="${ABUNDOMY_DOMAIN:-167-233-171-25.sslip.io}"
KEY="${ABUNDOMY_IPNS_KEY:-abundomy-app}"
BUNDLE="dist-bundle"

# Hetzner-anker (IPFS-Cluster + IPNS-publisher). Leeg laten schakelt stap 5b uit.
ANCHOR_SSH="${ABUNDOMY_ANCHOR_SSH:-root@167.233.171.25}"
ANCHOR_IPFS_PATH="${ABUNDOMY_ANCHOR_IPFS_PATH:-/var/lib/abundomy-ipfs/.ipfs}"

cd "$(dirname "$0")"   # → abundomy-dapp/

# 1) build
if [ "${1:-}" = "--no-build" ]; then
  echo "▶ 1/6  Build overgeslagen (--no-build)"
else
  echo "▶ 1/6  Build content-site (build:site) + SPA (vite, base './')…"
  npm run build:site
  npm run build:web
fi

# 2) relay.json (= het te dialen Hetzner-anker) in de SPA-build.
#    RELAY-LOOS: addr wijst naar de stabiele AutoTLS-wss van het anker (*.libp2p.direct,
#    afgeleid van peer-ID + vaste IPv4 → blijft geldig over restarts). vite kopieert
#    web/public/relay.json al naar dist-web/; we nemen 'm 1-op-1 over (geen domein-rewrite).
echo "▶ 2/6  Anker-relay.json in de SPA-build…"
[ -f web/public/relay.json ] || { echo "✗ web/public/relay.json ontbreekt"; exit 1; }
cp web/public/relay.json dist-web/relay.json
python3 -c "import json;print('  relay.json → ' + json.load(open('dist-web/relay.json'))['addr'])"

# 3) bundel samenstellen: content op /, SPA op /app/
echo "▶ 3/6  Bundel samenstellen (content op /, app op /app/)…"
[ -d web/site-dist ] || { echo "✗ web/site-dist/ ontbreekt — draai zonder --no-build (build:site draait dan automatisch) of eerst 'npm run build:site'"; exit 1; }
rm -rf "$BUNDLE"
mkdir -p "$BUNDLE/app"
cp -r web/site-dist/. "$BUNDLE/"     # content-site → bundel-root
cp -r dist-web/.      "$BUNDLE/app/"  # SPA (incl. relay.json) → /app/
echo "  bundel: $(du -sh "$BUNDLE" | cut -f1)"

# 4) IPNS-sleutel + vorige CID
KEYID=$(ipfs key list -l | awk -v k="$KEY" '$2==k {print $1}')
[ -z "$KEYID" ] && { echo "✗ IPNS-sleutel '$KEY' bestaat niet — maak 'm met: ipfs key gen --type=ed25519 $KEY"; exit 1; }
OLD=$(ipfs name resolve "/ipns/$KEYID" 2>/dev/null | sed 's#^/ipfs/##' || true)

echo "▶ 4/6  Toevoegen aan Kubo + pinnen…"
CID=$(ipfs add -rQ --cid-version=1 "$BUNDLE")
ipfs pin add "$CID" >/dev/null
echo "  nieuwe CID : $CID"
echo "  vorige CID : ${OLD:-<geen>}"

# 5) publiceren
echo "▶ 5/6  Publiceren onder IPNS-sleutel '$KEY'…"
ipfs name publish --key="$KEY" --ttl=30s --quieter "/ipfs/$CID" >/dev/null
echo "  /ipns/$KEYID → /ipfs/$CID"

# 5b) repliceren naar het Hetzner-anker via IPFS-Cluster + anker mee laten publishen
echo "▶ 5b   Repliceren naar het Hetzner-anker (cluster + IPNS)…"
if command -v ipfs-cluster-ctl >/dev/null 2>&1; then
  if ipfs-cluster-ctl pin add --name "abundomy-site" "$CID" >/dev/null 2>&1; then
    echo "  cluster-pin gezet: $CID (repliceert naar anker)"
  else
    echo "  ⚠ cluster-pin faalde (cluster onbereikbaar?) — anker krijgt deze CID later"
  fi
  if [ -n "$ANCHOR_SSH" ] && ssh -o BatchMode=yes -o ConnectTimeout=8 "$ANCHOR_SSH" \
        "sudo -u ipfs env IPFS_PATH='$ANCHOR_IPFS_PATH' /usr/local/bin/ipfs name publish --key='$KEY' --ttl=30s --lifetime=48h --quieter '/ipfs/$CID'" >/dev/null 2>&1; then
    echo "  anker publiceerde IPNS → /ipfs/$CID"
  else
    echo "  ⚠ anker-IPNS-publish overgeslagen (anker onbereikbaar?) — anker republisht z'n laatste record"
  fi
  # 5c) anker-Kubo herstarten: de in-memory IPNS-resolve-cache (ResolveCacheSize, géén TTL)
  #     houdt na een publish de vorige CID vast (~48h) → de gateway serveert anders oud.
  #     Replicator + ipfs-cluster reconnecten binnen enkele seconden.
  if [ -n "$ANCHOR_SSH" ] && ssh -o BatchMode=yes -o ConnectTimeout=8 "$ANCHOR_SSH" "systemctl restart ipfs" >/dev/null 2>&1; then
    echo "  anker-Kubo herstart (IPNS-resolve-cache gewist)"
  else
    echo "  ⚠ anker-herstart faalde — gateway serveert mogelijk oude CID tot cache-expiry"
  fi
  if [ -n "${OLD:-}" ] && [ "$OLD" != "$CID" ]; then
    ipfs-cluster-ctl pin rm "$OLD" >/dev/null 2>&1 && echo "  cluster-ontpin: $OLD" || true
  fi
else
  echo "  (geen ipfs-cluster-ctl op deze host — stap 5b overgeslagen)"
fi

# 6) opruimen
echo "▶ 6/6  Oude CID opruimen…"
if [ -z "${OLD:-}" ] || [ "$OLD" = "$CID" ]; then
  echo "  niets te doen (CID ongewijzigd of geen vorige)"
elif ! ipfs pin ls --type=recursive "$OLD" >/dev/null 2>&1; then
  # De cluster-ontpin in stap 5b haalt de pin óók lokaal uit Kubo weg. Dan valt hier
  # niets meer te ontpinnen — dat is de normale gang van zaken, geen fout.
  echo "  al ontpind via de cluster-ontpin in stap 5b"
elif ipfs pin rm "$OLD" >/dev/null 2>&1; then
  echo "  ontpind: $OLD"
else
  echo "  ⚠ kon $OLD niet ontpinnen"
fi

echo
echo "✅ Live op https://$DOMAIN  (content-site)  ·  app op https://$DOMAIN/app/"
echo "   CID: $CID"
echo "   Bezoekers zien de update zodra de IPNS/gateway-cache ververst (meestal < enkele minuten)."
