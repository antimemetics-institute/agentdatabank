#!/usr/bin/env bash
# Regenerate every GUI screenshot the docs embed, in light AND dark variants
# (<name>-light.png / <name>-dark.png under docs/book/src/images/; the book shows
# the one matching the reader's mdbook theme via theme/adb-theme-images.css).
#
# Serves the nix-built frontend against an EMPTY run store — the state a new
# reader sees in getting-started. Add a "name route" line to SHOTS for each new
# screenshot the book embeds. Run via `task docs:screenshots`.
set -euo pipefail
cd "$(dirname "$0")/.."

SHOTS=(
  "overview /"
)

PORT=8391
OUT=docs/book/src/images
WIN=1024,800

DIST=$(nix build .#adb-web-dist --print-out-paths --no-link)
MAN=$(nix build .#manifests --print-out-paths --no-link)
STORE=$(mktemp -d)

ADB_WEB_STATIC="$DIST" ADB_WEB_MANIFESTS="$MAN" \
  node "$DIST/server.cjs" --home "$STORE" --port "$PORT" --no-open &
SERVER=$!
trap 'kill $SERVER 2>/dev/null; rm -rf "$STORE"' EXIT

for _ in $(seq 50); do
  curl -sf "http://127.0.0.1:$PORT/api/experiments" >/dev/null 2>&1 && break
  sleep 0.2
done

# fresh profile per capture: empty localStorage, so the app derives its theme from
# prefers-color-scheme — which --force-dark-mode flips to dark
shoot() { # shoot <outfile> <url> [extra chromium flags...]
  local out=$1 url=$2
  shift 2
  nix run --inputs-from . nixpkgs#chromium -- \
    --headless --disable-gpu --no-sandbox --hide-scrollbars \
    --user-data-dir="$(mktemp -d)" --window-size="$WIN" --virtual-time-budget=6000 \
    "$@" --screenshot="$out" "$url" 2>/dev/null
  echo "wrote $out"
}

mkdir -p "$OUT"
for entry in "${SHOTS[@]}"; do
  read -r name route <<<"$entry"
  url="http://127.0.0.1:$PORT$route"
  shoot "$OUT/$name-light.png" "$url"
  shoot "$OUT/$name-dark.png" "$url" --force-dark-mode
done
