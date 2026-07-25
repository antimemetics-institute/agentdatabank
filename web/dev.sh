#!/usr/bin/env bash
# `pnpm dev` — local iteration: the real API server on :8340 (node runs the TS
# directly, restarting on change) + vite's dev server (HMR) proxying /api to it.
set -euo pipefail
cd "$(dirname "$0")"
[ -d node_modules ] || pnpm install --frozen-lockfile
trap 'kill 0' EXIT
node --watch src/server.ts &
node_modules/.bin/vite
