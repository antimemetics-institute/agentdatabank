/* The no-"[object Object]" invariant: elStr is the chokepoint every event field
   passes through on its way to pixels, and it must never coerce an object with
   String(). The block-array fixtures mirror REAL inspect output (reasoning models
   emit content as typed block lists — the shape that leaked "[object Object]"
   into the feed the first time real model data hit the UI). */

import { test } from "node:test";
import assert from "node:assert/strict";
import { containsElision, elStr, splitContent } from "./content.ts";

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

/* new-shape shorthand: the common case is plain readable reasoning */
const plain = (text: string, reasoning: string) =>
  ({ text, reasoning, summarized: false, redacted: 0 });

test("splitContent separates in-block reasoning from text (inspect shape)", () => {
  // elStr's text-wins policy DROPS the reasoning block — splitContent keeps both lanes
  const msg = { role: "assistant", content: [
    { type: "reasoning", reasoning: "the test expects the old behavior, so…" },
    { type: "text", text: "I'll update the view." },
  ] };
  assert.deepEqual(splitContent(msg),
    plain("I'll update the view.", "the test expects the old behavior, so…"));
});

test("splitContent: reasoning-only turns land in the reasoning lane, not text", () => {
  const msg = { content: [{ type: "reasoning", reasoning: "check the failing test first" }] };
  assert.deepEqual(splitContent(msg), plain("", "check the failing test first"));
});

test("splitContent reads the OpenAI-compatible reasoning_content field too", () => {
  assert.deepEqual(splitContent({ content: "hi", reasoning_content: "hmm" }), plain("hi", "hmm"));
  // elided reasoning_content surfaces its preview
  assert.deepEqual(
    splitContent({ content: "hi", reasoning_content: { __elided: { bytes: 9000, preview: "first bit" } } }),
    plain("hi", "first bit…"));
});

test("splitContent: elision inside a reasoning block surfaces its preview", () => {
  const msg = { content: [
    { type: "reasoning", reasoning: { __elided: { bytes: 9000, preview: "deep thought" } } },
    { type: "text", text: "answer" },
  ] };
  assert.deepEqual(splitContent(msg), plain("answer", "deep thought…"));
});

/* The ContentReasoning contract (inspect_ai): redacted=true means `reasoning`
   is an OPAQUE replay payload and `summary` is the only readable text. This is
   the REAL Anthropic shape off the wire — the blob must never render. */
test("splitContent: redacted reasoning renders the summary, never the payload (anthropic)", () => {
  const msg = { role: "assistant", content: [
    { type: "reasoning", reasoning: "EoZ6CpMBCBAYAipA1OF6…", summary: "Let me break down the problem…",
      signature: null, redacted: true },
    { type: "text", text: "Here's the solution." },
  ] };
  const r = splitContent(msg);
  assert.deepEqual(r, {
    text: "Here's the solution.",
    reasoning: "Let me break down the problem…",
    summarized: true,
    redacted: 0,
  });
  assert.ok(!r.reasoning.includes("EoZ6"));
});

test("splitContent: fully-redacted blocks (no summary) are counted, not rendered", () => {
  const msg = { content: [
    { type: "reasoning", reasoning: "encrypted-blob-1", redacted: true },
    { type: "reasoning", reasoning: "encrypted-blob-2", redacted: true, summary: null },
    { type: "text", text: "answer" },
  ] };
  assert.deepEqual(splitContent(msg), { text: "answer", reasoning: "", summarized: false, redacted: 2 });
});

test("splitContent: redacted check beats elision — an elided opaque payload stays hidden", () => {
  // both fields over the wire-diet threshold: reasoning (blob) AND summary elided
  const msg = { content: [
    { type: "reasoning", redacted: true,
      reasoning: { __elided: { bytes: 20836, preview: "EoZ6CpMBCBAYAipA" } },
      summary: { __elided: { bytes: 9436, preview: "Let me break down" } } },
    { type: "text", text: "done" },
  ] };
  const r = splitContent(msg);
  assert.equal(r.reasoning, "Let me break down…");
  assert.equal(r.summarized, true);
  assert.ok(!r.reasoning.includes("EoZ6"));
});

test("elStr's reasoning fallback also honors the redacted contract", () => {
  // reasoning-only message content (no text blocks) → elStr falls back to reasoning,
  // which must be the readable summary, not the payload
  const blocks = [{ type: "reasoning", reasoning: "opaque-blob", summary: "readable", redacted: true }];
  assert.equal(elStr(blocks), "readable");
});

test("splitContent tolerates absent and odd messages", () => {
  const empty = { text: "", reasoning: "", summarized: false, redacted: 0 };
  assert.deepEqual(splitContent(undefined), empty);
  assert.deepEqual(splitContent(null), empty);
  assert.deepEqual(splitContent({}), empty);
  assert.deepEqual(splitContent({ content: "plain string" }), plain("plain string", ""));
  // non-text blocks still name themselves; nothing coerces to [object Object]
  assert.equal(splitContent({ content: [{ type: "image", image: "data:…" }] }).text, "[image]");
  assert.ok(!JSON.stringify(splitContent({ content: [{ weird: 1 }] })).includes("[object Object]"));
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
