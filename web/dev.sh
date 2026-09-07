#!/usr/bin/env bash
# `pnpm dev` — local execution, API rebuilds, and Vite frontend hot reload.
set -euo pipefail
cd "$(dirname "$0")"
[ -d node_modules ] || pnpm install --frozen-lockfile
exec node dev.mjs
