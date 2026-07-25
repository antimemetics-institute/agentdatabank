#!/usr/bin/env bash
# Record the docs video clips (light + dark), sibling to scripts/docs-screenshots.sh:
# serve the nix-built GUI against an empty store, drive it with playwright
# (scripts/docs-gif/record.mjs) via the nixpkgs chromium, convert the captured
# capture to a compact VP9 webm (full framerate + color — a GIF here would be
# potato quality at 10x the bytes). Run via `task docs:clips`; pass a scenario
# name (builder | run-view) to re-record only that pair.
set -euo pipefail
cd "$(dirname "$0")/.."
ONLY=${1:-}
want() { [ -z "$ONLY" ] || [ "$ONLY" = "$1" ]; }

PORT=8392
OUT=docs/book/src/images

DIST=$(nix build .#adb-web-dist --print-out-paths --no-link)
MAN=$(nix build .#manifests --print-out-paths --no-link)
STORE=$(mktemp -d)
PW_BROWSERS="$(nix build --inputs-from . nixpkgs#playwright-driver.browsers --print-out-paths --no-link)"

ADB_WEB_STATIC="$DIST" ADB_WEB_MANIFESTS="$MAN" \
  node "$DIST/server.cjs" --home "$STORE" --port "$PORT" --no-open &
SERVER=$!
trap 'kill $SERVER 2>/dev/null; rm -rf "$STORE"' EXIT

for _ in $(seq 50); do
  curl -sf "http://127.0.0.1:$PORT/api/experiments" >/dev/null 2>&1 && break
  sleep 0.2
done

(cd scripts/docs-gif && [ -d node_modules ] || pnpm install --silent)

record() { # record <scenario> <name> [DARK]
  local scenario=$1 name=$2 dark=${3:-}
  local vid_dir
  vid_dir=$(mktemp -d)
  PLAYWRIGHT_BROWSERS_PATH="$PW_BROWSERS" BASE_URL="http://127.0.0.1:$PORT" \
    OUT_DIR="$vid_dir" DARK="$dark" SCENARIO="$scenario" node scripts/docs-gif/record.mjs
  # encode the lossless PNG frames (recorded at measured fps) with VP9: crisp text,
  # full color, a fraction of what a GIF would weigh
  local fps
  fps=$(cat "$vid_dir/fps.txt")
  # -row-mt + -cpu-used 5: minutes → seconds per clip; at this crf the quality
  # difference on flat UI content is imperceptible
  nix run --inputs-from . nixpkgs#ffmpeg -- -y -loglevel error \
    -framerate "$fps" -i "$vid_dir/f%05d.png" \
    -c:v libvpx-vp9 -crf 28 -b:v 0 -cpu-used 5 -row-mt 1 -threads 8 \
    -pix_fmt yuv420p -an "$OUT/$name.webm"
  rm -rf "$vid_dir"
  echo "wrote $OUT/$name.webm"
}

# clip 1 records against the still-empty store (the state a first-time reader sees)
if want builder; then
  record builder builder-form-light
  record builder builder-form-dark 1
fi

want run-view || exit 0

# clip 2 needs a run in the store to click into — a real one against the local
# llama server (falling back to the mock if it's unreachable). The populated store
# is CACHED so the ~20s eval is paid once, not on every re-record; delete the cache
# dir to record against a fresh run.
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/adb-docs-clips-store"
if [ ! -d "$CACHE/runs" ]; then
  CREDS=$(mktemp)
  cat > "$CREDS" <<'EOF'
[openai]
OPENAI_API_KEY = "unused"
OPENAI_BASE_URL = "http://llama.forest.local:11434/v1"
EOF
  RUN_MODEL=openai/qwen3.5-9b
  curl -sf -m 4 http://llama.forest.local:11434/v1/models >/dev/null 2>&1 || {
    echo "llama.forest.local unreachable — clip 2 shows a mock run instead"
    RUN_MODEL=mockllm/model
  }
  ADB_PROVIDERS_FILE="$CREDS" nix run .#inspect-hello -- \
    --out "$CACHE" \
    --set model="$RUN_MODEL" \
    --set limit=0 \
    --set epochs=1 \
    --set 'generate_args={}' >/dev/null 2>&1 || true
  rm -f "$CREDS"
fi

# swap the server onto the populated store for the run-view clips
kill $SERVER 2>/dev/null
ADB_WEB_STATIC="$DIST" ADB_WEB_MANIFESTS="$MAN" \
  node "$DIST/server.cjs" --home "$CACHE" --port "$PORT" --no-open &
SERVER=$!
for _ in $(seq 50); do
  curl -sf "http://127.0.0.1:$PORT/api/experiments" >/dev/null 2>&1 && break
  sleep 0.2
done

record run-view run-view-light
record run-view run-view-dark 1

