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
#   1. vite-build (tenzij --no-build)
#   2. publieke relay.json in dist-web (komt in /app/relay.json terecht)
#   3. bundel samenstellen: content op /, SPA op /app/
#   4. ipfs add + pin → nieuwe CID
#   5. ipfs name publish onder de IPNS-sleutel (DNSLink/DNS blijven ongemoeid)
#   6. de vorige CID ontpinnen
#
# Vereist: draaiende Kubo-daemon (ipfs.service) en de IPNS-sleutel (ABUNDOMY_IPNS_KEY).
# Wijzigt NIETS aan DNS, nginx of de live OrbitDB-data — alleen welke versie live is.
# Schrijft uitsluitend binnen abundomy-dapp/ (build-output); raakt geen bron-directories.
#
# Gebruik:  npm run deploy        of   bash deploy.sh [--no-build]
set -euo pipefail

DOMAIN="${ABUNDOMY_DOMAIN:-app.reikiwereld.eu}"
KEY="${ABUNDOMY_IPNS_KEY:-abundomy-app}"
BUNDLE="dist-bundle"

cd "$(dirname "$0")"   # → abundomy-dapp/

# 1) build
if [ "${1:-}" = "--no-build" ]; then
  echo "▶ 1/6  Build overgeslagen (--no-build)"
else
  echo "▶ 1/6  Build SPA (vite, base './')…"
  npm run build:web
fi

# 2) publieke relay.json in de SPA-build (de SPA haalt 'm relatief op vanuit /app/)
echo "▶ 2/6  Publieke relay.json in de SPA-build…"
[ -f web/public/relay.json ] || { echo "✗ web/public/relay.json ontbreekt (start de relay één keer)"; exit 1; }
python3 - "$DOMAIN" <<'PY'
import json, sys
domain = sys.argv[1]
src = json.load(open('web/public/relay.json'))
peer = src['addr'].split('/p2p/')[-1]          # relay-peerId (deterministisch)
addr = f'/dns4/{domain}/tcp/443/wss/p2p/{peer}'
json.dump({'addr': addr, 'stores': src['stores']}, open('dist-web/relay.json', 'w'), indent=2)
open('dist-web/relay.json', 'a').write('\n')
print('  relay.json →', addr)
PY

# 3) bundel samenstellen: content op /, SPA op /app/
echo "▶ 3/6  Bundel samenstellen (content op /, app op /app/)…"
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

# 6) opruimen
echo "▶ 6/6  Oude CID opruimen…"
if [ -n "${OLD:-}" ] && [ "$OLD" != "$CID" ]; then
  ipfs pin rm "$OLD" >/dev/null 2>&1 && echo "  ontpind: $OLD" || echo "  (kon $OLD niet ontpinnen)"
else
  echo "  niets te doen (CID ongewijzigd of geen vorige)"
fi

echo
echo "✅ Live op https://$DOMAIN  (content-site)  ·  app op https://$DOMAIN/app/"
echo "   CID: $CID"
echo "   Bezoekers zien de update zodra de IPNS/gateway-cache ververst (meestal < enkele minuten)."
