/* Parity tests for the TS port of the docs' command rewriting
   (docs/book/theme/adb-commands.js) — every expectation here is a form the docs
   gear menu produces, so a drift between the two implementations fails loudly. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { CMD_PREFS_DEFAULTS, previewCmd, rewriteCmd, type CmdPrefs } from "./cmd-rewrite.ts";

const p = (over: Partial<CmdPrefs>): CmdPrefs => ({ ...CMD_PREFS_DEFAULTS, ...over });

const GITHUB = "github:antimemetics-institute/adb";
const TARBALL = "https://github.com/antimemetics-institute/adb/archive/main.tar.gz";
const ARMOR = " --extra-experimental-features 'nix-command flakes'";

test("defaults: github ref, armored for stock nix", () => {
  assert.equal(
    rewriteCmd("nix run .#inspect-hello -- --set model=m", p({})),
    `nix run ${GITHUB}#inspect-hello${ARMOR} -- --set model=m`,
  );
});

test("flakes enabled globally drops the armor; registry shortens the ref", () => {
  assert.equal(
    rewriteCmd("nix run .#foo", p({ flakes: true })),
    `nix run ${GITHUB}#foo`,
  );
  assert.equal(
    rewriteCmd("nix run .#foo", p({ flakes: true, registry: true })),
    "nix run adb#foo",
  );
});

test("local checkout with global flakes is the canonical identity", () => {
  const cmd = "nix run .#foo -- --set a=1";
  assert.equal(rewriteCmd(cmd, p({ source: "local", flakes: true })), cmd);
});

test("nix-build mode: $(nix-build …) head, `--` separator dropped", () => {
  assert.equal(
    rewriteCmd("nix run .#foo -- --set a=1", p({ mode: "nix-build" })),
    `$(nix-build --no-out-link ${TARBALL} -A exec.foo) --set a=1`,
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
    `nix-run ${TARBALL} -A adb-web`,
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
    rewriteCmd("  nix run .#foo", p({ flakes: true })),
    `  nix run ${GITHUB}#foo`,
  );
});

test("preview follows the prefs", () => {
  assert.equal(previewCmd(p({ source: "local", flakes: true })), "nix run .#inspect-hello -- …");
});
