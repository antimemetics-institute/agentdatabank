#!/usr/bin/env bash
# Record four getting-started steps against an isolated local GUI. Run presses the
# real job button, but ADB_WORKER_BUILD supplies a saved-event replay executable.
# Usage: bash scripts/docs-clips.sh [scenario] --replay-run /path/to/run [--speed 15]
# PNG capture -> light/dark VP9 WebM, plus light GIFs for GitHub.
set -euo pipefail
cd "$(dirname "$0")/.."
ONLY=
REPLAY_RUN=
SPEED=15
while [ "$#" -gt 0 ]; do
  case "$1" in
    --replay-run) REPLAY_RUN=${2:?--replay-run requires a saved run directory}; shift 2 ;;
    --speed) SPEED=${2:?--speed requires a positive multiplier}; shift 2 ;;
    choose|model-credentials|launch|run-view) ONLY=$1; shift ;;
    *) echo "usage: $0 [scenario] --replay-run PATH [--speed 15]" >&2; exit 2 ;;
  esac
done
if [ ! -f "$REPLAY_RUN/run.json" ]; then
  echo "--replay-run must name a saved run directory containing run.json" >&2; exit 2
fi
REPLAY_RUN=$(cd "$REPLAY_RUN" && pwd)
node -e 'if (!(Number(process.argv[1]) > 0) || !Number.isFinite(Number(process.argv[1]))) process.exit(1)' "$SPEED"
want() { [ -z "$ONLY" ] || [ "$ONLY" = "$1" ]; }

PORT=8392
OUT=docs/book/src/images
README_OUT=docs/readme
mkdir -p "$OUT" "$README_OUT"

# the server walks to the next port when this one is taken, but BASE_URL below
# would still point here — recording someone else's store. Fail instead.
if curl -sf -o /dev/null "http://127.0.0.1:$PORT/api/experiments"; then
  echo "port $PORT is already serving an adb-web — kill it first" >&2; exit 1
fi

DIST=$(nix build .#adb-web-dist --print-out-paths --no-link)
RUNNER=$(nix build .#adb-runner --print-out-paths --no-link)
PW_BROWSERS="$(nix build --inputs-from . nixpkgs#playwright-driver.browsers --print-out-paths --no-link)"
STORE=
SERVER=
cleanup() {
  if [ -n "$SERVER" ]; then kill "$SERVER" 2>/dev/null || true; wait "$SERVER" 2>/dev/null || true; fi
  if [ -n "$STORE" ]; then rm -rf "$STORE"; fi
}
trap cleanup EXIT

# Each capture starts with empty credentials, preferences, and run data. The
# browser saves only a fake example key; the worker replays saved events.
start_server() {
  STORE=$(mktemp -d)
  mkdir -p "$STORE/config"
  ADB_WORKER_BUILD="$PWD/scripts/docs-gif/replay-build.mjs" ADB_DOCS_REPLAY_RUN="$REPLAY_RUN" \
  ADB_DOCS_REPLAY_SPEED="$SPEED" ADB_DOCS_REPLAY_DIR="$STORE/replay" \
  ADB_CREDENTIALS_FILE="$STORE/config/credentials.toml" XDG_CONFIG_HOME="$STORE/config" \
    node "$DIST/server.cjs" --execution-source "$PWD" --static-dir "$DIST" --runner "$RUNNER/bin/adb-runner" --executor-python "$RUNNER/bin/python" --data-dir "$STORE/data" --port "$PORT" --no-open &
  SERVER=$!
  # A refreshed model catalog rebuilds experiment manifests before serving.
  local deadline=$((SECONDS + 180))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if ! kill -0 "$SERVER" 2>/dev/null; then
      echo "docs server exited during startup; see server output above" >&2; return 1
    fi
    curl -sf --max-time 2 "http://127.0.0.1:$PORT/api/experiments" >/dev/null 2>&1 && return
    sleep 1
  done
  echo "docs server was not ready on port $PORT after 180s; see server output above" >&2; return 1
}

# Wait for replay jobs to finish before discarding each isolated store so
# a leftover queued job never pushes the next clip's ▶ run into a wait
drain_jobs() {
  for _ in $(seq 600); do
    curl -sf "http://127.0.0.1:$PORT/api/jobs" \
      | grep -qE '"state":"(queued|claimed|building|running)"' || return 0
    sleep 1
  done
  echo "jobs still live after 10m — giving up" >&2; return 1
}

(cd scripts/docs-gif && [ -d node_modules ] || pnpm install --silent)

record() { # record <scenario> <name> [DARK]
  local scenario=$1 name=$2 dark=${3:-}
  local vid_dir
  start_server
  vid_dir=$(mktemp -d)
  PLAYWRIGHT_BROWSERS_PATH="$PW_BROWSERS" BASE_URL="http://127.0.0.1:$PORT" \
    OUT_DIR="$vid_dir" DARK="$dark" SCENARIO="$scenario" \
    node scripts/docs-gif/record.mjs
  drain_jobs
  cleanup
  SERVER=
  STORE=
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

# Each step has its own focused clip; only launch and run-view execute jobs.
for scenario in choose model-credentials launch run-view; do
  if want "$scenario"; then
    record "$scenario" "$scenario-light"
    record "$scenario" "$scenario-dark" 1
  fi
done
