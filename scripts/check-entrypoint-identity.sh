#!/usr/bin/env bash
# Every entrypoint — nix run (flakes), $(nix-build …) (classic), and nix-run —
# must mint IDENTICAL condition identity (source content hash + condition id)
# for the same experiment and params on the same tree. This guards against
# eval-path drift (flake store copies, path filtering, arg plumbing) silently
# fragmenting conditions by entrypoint. Keyless: inspect-hello on mockllm, --dry-run
# only (nothing executes, nothing is written to the databank).
#
# Note the flake entrypoint sees git-TRACKED files only — a mismatch here can also
# mean a file that should be tracked isn't yet.
set -euo pipefail
cd "$(dirname "$0")/.."

exp=inspect-hello
args=(--set model=mockllm/model --set limit=0 --set epochs=1 --set 'generate_args={}' --dry-run)

# dry-run output carries:  "source:     content:sha256:…"  and
# "condition <abbrev>  (<full-cid>)" — the base seed line is random and ignored
extract() { awk '/^source:/ { print $2 } /^condition / { gsub(/[()]/, "", $NF); print $NF }'; }

echo "entrypoint: nix-build" >&2
d_build=$("$(nix-build --no-out-link -A "exec.$exp")" "${args[@]}" | extract)

echo "entrypoint: flakes" >&2
d_flake=$(nix run ".#$exp" --extra-experimental-features 'nix-command flakes' -- "${args[@]}" | extract)

echo "entrypoint: nix-run" >&2
d_nrun=$(nix-shell -p nix-run --run "nix-run . -A experiment-$exp -- $(printf '%q ' "${args[@]}")" | extract)

if [ "$d_build" = "$d_flake" ] && [ "$d_build" = "$d_nrun" ]; then
  printf 'OK: all entrypoints agree\n%s\n' "$d_build"
else
  printf 'MISMATCH across entrypoints\n-- nix-build --\n%s\n-- flakes --\n%s\n-- nix-run --\n%s\n' \
    "$d_build" "$d_flake" "$d_nrun" >&2
  exit 1
fi
