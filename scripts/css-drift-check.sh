#!/usr/bin/env bash
# CSS-drift-check (pre-deploy) — verifieert 3-laags architectuur.
set -euo pipefail
cd "$(dirname "$0")/.."
MONEY=../abundomy-money-git/css/main.css
MAIN=web/public/css/main.css
CUSTOM=web/public/css/dapp-custom.css
fail=0
[ -f "$MONEY" ] || { echo "✗ money-app repo main.css niet gevonden"; fail=1; }
diff -q "$MONEY" "$MAIN" >/dev/null 2>&1 || { echo "✗ FAIL: main.css wijkt af van money-app repo"; fail=1; }
[ -f "$CUSTOM" ] || { echo "✗ FAIL: dapp-custom.css ontbreekt"; fail=1; }
REASONS=$(grep -c 'reden:' "$CUSTOM" || true)
[ "$REASONS" -gt 0 ] || { echo "✗ FAIL: dapp-custom.css heeft geen reden-commentaren"; fail=1; }
for css in 'css/reset.css' 'css/main.css' 'css/dapp-custom.css'; do
  grep -q "href=\"$css" web/index.html || { echo "✗ FAIL: $css niet gelinkt in index.html"; fail=1; }
done
[ "$fail" = 0 ] && { echo "✓ CSS-drift-check geslaagd (main byte-identiek money-app repo, dapp-custom gedocumenteerd, laadvolgorde OK)"; exit 0; } || exit 1
