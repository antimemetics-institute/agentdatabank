#!/usr/bin/env bash
# Record the docs video clips (light + dark), sibling to scripts/docs-screenshots.sh:
# serve the nix-built GUI against an empty store WITH a live worker attached (the
# adb-local shape — the clips press ▶ run for real), drive it with playwright
# (scripts/docs-gif/record.mjs) via the nixpkgs chromium, convert the captured
# frames to a compact VP9 webm (full framerate + color — a GIF here would be
# potato quality at 10x the bytes). Run via `task docs:clips`; pass a scenario
# name (builder | run-view) to re-record only that pair.
set -euo pipefail
cd "$(dirname "$0")/.."
ONLY=${1:-}
want() { [ -z "$ONLY" ] || [ "$ONLY" = "$1" ]; }

PORT=8392
OUT=docs/book/src/images
README_OUT=docs/readme
mkdir -p "$README_OUT"

# the server walks to the next port when this one is taken, but BASE_URL below
# would still point here — recording someone else's store. Fail instead.
if curl -sf -o /dev/null "http://127.0.0.1:$PORT/api/experiments"; then
  echo "port $PORT is already serving an adb-web — kill it first" >&2; exit 1
fi

DIST=$(nix build .#adb-web-dist --print-out-paths --no-link)
MAN=$(nix build .#manifests --print-out-paths --no-link)
RUNNER=$(nix build .#adb-runner --print-out-paths --no-link)
WORKER=$(nix build .#adb-worker --print-out-paths --no-link)
STORE=$(mktemp -d)
PW_BROWSERS="$(nix build --inputs-from . nixpkgs#playwright-driver.browsers --print-out-paths --no-link)"

# the model ▶ run executes: the local llama server when reachable, else the mock.
# The credential store is what the worker resolves the `openai` profile from —
# the server proxies the same file for the run tab's profile row.
RUN_MODEL=openai/qwen3.5-9b
curl -sf -m 4 http://llama.forest.local:11434/v1/models >/dev/null 2>&1 || {
  echo "llama.forest.local unreachable — the clips run the mock model instead"
  RUN_MODEL=mockllm/model
}
CREDS=$(mktemp)
cat > "$CREDS" <<'EOF'
[openai.default]
OPENAI_API_KEY = "unused"
OPENAI_BASE_URL = "http://llama.forest.local:11434/v1"
EOF

ADB_WEB_STATIC="$DIST" ADB_WEB_MANIFESTS="$MAN" \
  ADB_RUNNER="$RUNNER/bin/adb-runner" ADB_CREDENTIALS_FILE="$CREDS" \
  node "$DIST/server.cjs" --home "$STORE" --port "$PORT" --no-open &
SERVER=$!
trap 'kill $SERVER ${WORKER_PID:-} 2>/dev/null; rm -rf "$STORE" "$CREDS"' EXIT

for _ in $(seq 50); do
  curl -sf "http://127.0.0.1:$PORT/api/experiments" >/dev/null 2>&1 && break
  sleep 0.2
done

# the worker, exactly as adb-local starts it: builds from this live checkout,
# runs against the same store the server serves
ADB_HOME="$STORE" ADB_CREDENTIALS_FILE="$CREDS" \
  "$WORKER/bin/adb-worker" --server "http://127.0.0.1:$PORT" \
  --name this-machine --repo "$PWD" &
WORKER_PID=$!

# pre-warm the build the worker will run per job, so the recorded "building"
# phase is eval-only seconds instead of a cold build
nix-build . -A exec.inspect-hello --no-out-link >/dev/null

# each recording launches a real job; let it finish before the next recording so
# a leftover queued job never pushes the next clip's ▶ run into a wait
drain_jobs() {
  for _ in $(seq 600); do
    curl -sf "http://127.0.0.1:$PORT/api/jobs" \
      | grep -qE '"phase":"(queued|claimed|building|running)"' || return 0
    sleep 1
  done
  echo "jobs still live after 10m — giving up" >&2; return 1
}

(cd scripts/docs-gif && [ -d node_modules ] || pnpm install --silent)

record() { # record <scenario> <name> [DARK]
  local scenario=$1 name=$2 dark=${3:-}
  local vid_dir
  vid_dir=$(mktemp -d)
  PLAYWRIGHT_BROWSERS_PATH="$PW_BROWSERS" BASE_URL="http://127.0.0.1:$PORT" \
    OUT_DIR="$vid_dir" DARK="$dark" SCENARIO="$scenario" RUN_MODEL="$RUN_MODEL" \
    node scripts/docs-gif/record.mjs
  drain_jobs
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
  # the light clip doubles as the README's gif — GitHub markdown won't play a
  # repo-relative webm; 10fps + 720px + quantized palette keeps it a committable size
  if [ -z "$dark" ]; then
    nix run --inputs-from . nixpkgs#ffmpeg -- -y -loglevel error \
      -framerate "$fps" -i "$vid_dir/f%05d.png" \
      -vf "fps=10,scale=720:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=4" \
      "$README_OUT/${name%-light}.gif"
    echo "wrote $README_OUT/${name%-light}.gif"
  fi
  rm -rf "$vid_dir"
  echo "wrote $OUT/$name.webm"
}

# clip 1 records against the still-empty store (the state a first-time reader
# sees) and ends with a real ▶ run; clip 2 replays that ending off-camera and
# follows the launched run's transcript
if want builder; then
  record builder builder-form-light
  record builder builder-form-dark 1
fi

if want run-view; then
  record run-view run-view-light
  record run-view run-view-dark 1
fi
