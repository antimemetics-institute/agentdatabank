/* The no-"[object Object]" invariant: elStr is the chokepoint every event field
   passes through on its way to pixels, and it must never coerce an object with
   String(). The block-array fixtures mirror REAL inspect output (reasoning models
   emit content as typed block lists — the shape that leaked "[object Object]"
   into the feed the first time real model data hit the UI). */

import { test } from "node:test";
import assert from "node:assert/strict";
import { containsElision, elStr } from "./content.ts";

test("plain strings and nullish pass through", () => {
  assert.equal(elStr("hello"), "hello");
  assert.equal(elStr(null), "");
  assert.equal(elStr(undefined), "");
  assert.equal(elStr(42), "42");
});

test("inspect-style content block lists extract their text", () => {
  const qwen = [
    { type: "reasoning", reasoning: "the user wants the word model…" },
    { type: "text", text: "As an AI model, happy to help." },
  ];
  assert.equal(elStr(qwen), "As an AI model, happy to help.");
  // reasoning-only content (mid-stream) falls back to the reasoning text
  assert.equal(elStr([{ type: "reasoning", reasoning: "thinking…" }]), "thinking…");
  // non-text block types name themselves instead of vanishing
  assert.equal(elStr([{ type: "image", image: "data:…" }, { type: "text", text: "caption" }]), "[image]\ncaption");
  assert.equal(elStr([{ type: "image", image: "data:…" }]), "[image]");
});

test("elision markers render their preview", () => {
  assert.equal(elStr({ __elided: { bytes: 9999, preview: "long tex…" } }), "long tex…");
  assert.equal(elStr({ __elided: { bytes: 9999 } }), "");
});

test("elision INSIDE a content block surfaces the preview, not [text]", () => {
  // the wire elides long strings anywhere — including the text of a typed block
  const blocks = [{ type: "text", text: { __elided: { bytes: 9000, preview: "first 200 chars" } } }];
  assert.equal(elStr(blocks), "first 200 chars…");
  const rblocks = [{ type: "reasoning", reasoning: { __elided: { bytes: 9000, preview: "thinking" } } }];
  assert.equal(elStr(rblocks), "thinking…");
});

test("containsElision finds nested markers where isElided misses", () => {
  const blocks = [{ type: "text", text: { __elided: { bytes: 9000, preview: "p" } } }];
  assert.equal(containsElision(blocks), true);
  assert.equal(containsElision({ __elided: { bytes: 1 } }), true);
  assert.equal(containsElision("plain"), false);
  assert.equal(containsElision(undefined), false);
});

test("NOTHING renders as [object Object]", () => {
  const nasty: unknown[] = [
    [{ type: "reasoning", reasoning: "r" }, { type: "text", text: "t" }],
    [{}, {}],
    [{ weird: 1 }],
    { plain: "object" },
    [[{ nested: true }]],
    [null, undefined, "x"],
  ];
  for (const v of nasty) {
    assert.ok(!elStr(v).includes("[object Object]"), `leaked for ${JSON.stringify(v)}`);
  }
});
