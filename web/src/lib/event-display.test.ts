import assert from "node:assert/strict";
import test from "node:test";
import { exitLabel, fetchRefHref, storePackage, stripAnsi } from "./event-display.ts";

test("captured lines lose terminal codes while preserving text and line breaks", () => {
  assert.equal(stripAnsi('\x1b[31mred\x1b[0m\n\x1b]8;;https://example.org\x07link\x1b]8;;\x07\nnormal'), 'red\nlink\nnormal');
  assert.equal(stripAnsi('\x1b]0;window title\x1b\\text\x9b2K'), 'text');
});

test("negative process codes show the recorded platform's signal", () => {
  assert.equal(exitLabel(0), "exit 0");
  assert.equal(exitLabel(-15, "Linux"), "exit -15 (SIGTERM)");
  assert.equal(exitLabel(-10, "Linux"), "exit -10 (SIGUSR1)");
  assert.equal(exitLabel(-10, "Darwin"), "exit -10 (SIGBUS)");
  assert.equal(exitLabel(-35, "Linux"), "exit -35 (SIGRTMIN+1)");
  assert.equal(exitLabel(-99), "exit -99 (signal 99)");
});

test("provenance abbreviations retain package names and link pinned revisions", () => {
  assert.equal(storePackage('/nix/store/0123456789abcdefghijklmnpqrsvwxyz-govsim-adapter/bin/govsim'), 'govsim-adapter');
  assert.equal(fetchRefHref('github:owner/repo/abc123?dir=packaging'), 'https://github.com/owner/repo/tree/abc123/packaging');
  assert.equal(fetchRefHref('git+https://example.org/repo.git?rev=abc'), 'https://example.org/repo.git?rev=abc');
  assert.equal(fetchRefHref('javascript:alert(1)'), null);
});
