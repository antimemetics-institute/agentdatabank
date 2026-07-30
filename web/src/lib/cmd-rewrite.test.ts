/* Parity tests for the TS port of the docs' command rewriting
   (docs/book/theme/adb-commands.js) — every expectation here is a form the docs
   gear menu produces, so a drift between the two implementations fails loudly. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { CMD_PREFS_DEFAULTS, REPO_LOCAL_PREFS, previewCmd, rewriteCmd, type CmdPrefs } from "./cmd-rewrite.ts";

const p = (over: Partial<CmdPrefs>): CmdPrefs => ({ ...CMD_PREFS_DEFAULTS, ...over });

const GITHUB = "github:antimemetics-institute/agentdatabank";
const TARBALL = "https://github.com/antimemetics-institute/agentdatabank/archive/main.tar.gz";
const ARMOR = " --extra-experimental-features 'nix-command flakes'";

test("defaults: stock nix-build exec form, fresh tarball continued before -A", () => {
  assert.equal(
    rewriteCmd("nix run .#inspect-hello -- --set model=m", p({})),
    `$(nix-build --no-out-link --tarball-ttl 0 ${TARBALL} \\\n  -A exec.inspect-hello) --set model=m`,
  );
});

test("flakes mode: github ref, armored for stock nix, refreshed", () => {
  assert.equal(
    rewriteCmd("nix run .#inspect-hello -- --set model=m", p({ mode: "flakes" })),
    `nix run ${GITHUB}#inspect-hello${ARMOR} --refresh -- --set model=m`,
  );
});

test("flakes enabled globally drops the armor; registry shortens the ref", () => {
  assert.equal(
    rewriteCmd("nix run .#foo", p({ mode: "flakes", flakes: true })),
    `nix run ${GITHUB}#foo --refresh`,
  );
  assert.equal(
    rewriteCmd("nix run .#foo", p({ mode: "flakes", flakes: true, registry: true })),
    "nix run adb#foo --refresh",
  );
});

test("latest off drops the freshness flags; local checkout never carries them", () => {
  assert.equal(
    rewriteCmd("nix run .#foo", p({ latest: false })),
    `$(nix-build --no-out-link ${TARBALL} \\\n  -A exec.foo)`,
  );
  assert.equal(
    rewriteCmd("nix run .#foo", p({ mode: "flakes", flakes: true, latest: false })),
    `nix run ${GITHUB}#foo`,
  );
  // latest:true + local is inert — nothing cached to bypass
  assert.equal(
    rewriteCmd("nix run .#foo", p({ source: "local" })),
    "$(nix-build --no-out-link -A exec.foo)",
  );
});

test("local checkout with global flakes is the canonical identity", () => {
  const cmd = "nix run .#foo -- --set a=1";
  assert.equal(rewriteCmd(cmd, p({ mode: "flakes", source: "local", flakes: true })), cmd);
});

test("nix-build mode: $(nix-build …) head, `--` separator dropped", () => {
  assert.equal(
    rewriteCmd("nix run .#foo -- --set a=1", p({ mode: "nix-build" })),
    `$(nix-build --no-out-link --tarball-ttl 0 ${TARBALL} \\\n  -A exec.foo) --set a=1`,
  );
  assert.equal(
    rewriteCmd("nix run .#foo", p({ mode: "nix-build", source: "local" })),
    "$(nix-build --no-out-link -A exec.foo)",
  );
});

test("nix-run installed: head swap, experiment- prefix except adb-* packages", () => {
  assert.equal(
    rewriteCmd("nix run .#foo -- --set a=1", p({ mode: "nix-run", nixRun: true, source: "local" })),
    "nix-run . -A experiment-foo -- --set a=1",
  );
  assert.equal(
    rewriteCmd("nix run .#adb-web", p({ mode: "nix-run", nixRun: true })),
    `nix-run --option tarball-ttl 0 ${TARBALL} \\\n  -A adb-web`,
  );
});

test("nix-run not installed wraps the whole span in nix-shell --run", () => {
  assert.equal(
    rewriteCmd("nix run .#foo -- x", p({ mode: "nix-run", source: "local" })),
    'nix-shell -p nix-run --run "nix-run . -A experiment-foo -- x"',
  );
  // multi-line: the closing quote lands on the LAST continued line
  assert.equal(
    rewriteCmd("nix run .#foo -- \\\n  --set a=1 \\\n  --set b=2", p({ mode: "nix-run", source: "local" })),
    'nix-shell -p nix-run --run "nix-run . -A experiment-foo -- \\\n  --set a=1 \\\n  --set b=2"',
  );
});

test("non-command text and indentation are preserved", () => {
  assert.equal(rewriteCmd("echo hello", p({})), "echo hello");
  assert.equal(
    rewriteCmd("  nix run .#foo", p({ mode: "flakes", flakes: true })),
    `  nix run ${GITHUB}#foo --refresh`,
  );
});

test("external experiments pin the repo-local stock-nix form, palette ignored", () => {
  // REPO_LOCAL_PREFS is what the builder substitutes for the user's palette when
  // a manifest's origin is "external" — the adb sources cannot name those, so
  // the only truthful command runs from the experiment repo's own directory
  assert.equal(
    rewriteCmd("nix run .#my-exp -- --set model=m", REPO_LOCAL_PREFS),
    "$(nix-build --no-out-link -A exec.my-exp) --set model=m",
  );
});

test("preview follows the prefs", () => {
  assert.equal(
    previewCmd(p({ mode: "flakes", source: "local", flakes: true })),
    "nix run .#inspect-hello -- …",
  );
});
