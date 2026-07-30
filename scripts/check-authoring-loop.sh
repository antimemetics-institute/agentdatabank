#!/usr/bin/env bash
# The authoring loop end-to-end: adb-dev init pinned at a parent rev, bump to
# the tip, verify every pinned surface — default.nix, pyproject sources,
# uv.lock — lands on the tip, then run the scaffold keylessly through the adb
# checkout's --arg door and check the scaffold's own doors agree.
#
# The "tip" is HEAD on a clean tree. On a dirty tree it is a synthetic commit
# of the working tree (git stash create — tracked files only, nothing moves),
# so this checks what you are about to commit, not what you last committed.
# Either way the tip is pushed as `main` of a throwaway bare mirror, because
# the scaffold's pin block hardcodes ref = "main" — and neither a stash commit
# nor a PR merge commit is reachable from the real main.
set -euo pipefail
cd "$(dirname "$0")/.."

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

head="$(git stash create || true)"
if [ -n "$head" ]; then
  parent="$(git rev-parse HEAD)"
else
  head="$(git rev-parse HEAD)"
  parent="$(git rev-parse HEAD^)"
fi

adbsrc="$tmp/adb-src.git"
git init --bare --quiet -b main "$adbsrc" # -b: uv fetches HEAD, which must resolve
git push --quiet "$adbsrc" "$head:refs/heads/main"

scaffold="$tmp/ci-chat"
adb_dev="$(nix-build --no-out-link -A exec.adb-dev)"

# init pins the PARENT rev with --no-lock (nothing resolves against it), so
# bump has a real move to make
"$adb_dev" init ci-chat --dir "$scaffold" --adb-url "file://$adbsrc" \
  --rev "$parent" --no-lock
(cd "$scaffold" && "$adb_dev" bump --rev "$head")
test "$(cd "$scaffold" && "$adb_dev" pin)" = "$head"
grep -q "rev = \"$head\"" "$scaffold/pyproject.toml"
grep -qF "$head" "$scaffold/uv.lock"

# a real keyless run through the adb checkout's --arg door
ADB_HOME="$tmp/adb-home" \
  "$(nix-build --no-out-link -A exec.ci-chat --arg experiments "$scaffold")" \
  --set 'prompt=Say one surprising thing.' --set turns=2 \
  --set model=mock/model --set temperature=0.7

# and the scaffold's own doors (its default.nix + fetchGit pin) agree
./scripts/check-entrypoint-identity.sh --dir "$scaffold" --exp ci-chat -- \
  --set 'prompt=Say one surprising thing.' --set turns=2 \
  --set model=mock/model --set temperature=0.7

# fork: a registry experiment lifted out into the same external shape — verify
# the copy, the rename, and the path→git source rewrite land where the pin says.
# --no-lock keeps this leg cheap: resolving and building the fork re-proves what
# the init leg and the in-tree experiment's own CI already cover.
fork="$tmp/ci-concordia"
"$adb_dev" fork concordia ci-concordia --dir "$fork" \
  --adb-url "file://$adbsrc" --rev "$head" --no-lock
grep -q "rev = \"$head\"" "$fork/default.nix"
grep -q "ci-concordia = adb.mkExperiment" "$fork/package.nix"
grep -q "name = \"ci-concordia\"" "$fork/package.nix"
grep -q "subdirectory = \"lib/adb-events\"" "$fork/pyproject.toml"
grep -q "rev = \"$head\"" "$fork/pyproject.toml"
! grep -q "path = \"\.\./\.\./lib" "$fork/pyproject.toml"
