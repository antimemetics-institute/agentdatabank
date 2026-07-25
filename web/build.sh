#!/usr/bin/env bash
# THE web build — nix, devshells, and CI all call this exact script. Requires node +
# an installed node_modules (pnpm; nix's pnpmConfigHook provides it in the sandbox).
# Output: dist/ = the vite-built frontend + server.js (node stdlib only at runtime).
set -euo pipefail
cd "$(dirname "$0")"

[ -d node_modules ] || pnpm install --frozen-lockfile

# 1. browser app (React + Tailwind, hashed assets, index.html entry)
node_modules/.bin/vite build

# 2. server bundle — the server itself has zero runtime dependencies (node stdlib);
#    esbuild here only strips types and inlines src/shared/types.ts. .cjs so the
#    bundle runs identically in-repo (package.json says type=module) and from $out
node_modules/.bin/esbuild src/server.ts --bundle --minify --platform=node \
  --format=cjs --outfile=dist/server.cjs

echo "build.sh: dist/ ready"
