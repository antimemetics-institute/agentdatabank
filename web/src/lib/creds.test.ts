/* The browser mirror of the runner's credential routing must agree with
   credentials.py — these cases are transcribed from runner/tests/test_credentials.py
   (werewolf's listOf(struct), concordia's param-wrapped fields, openai-api service
   routing) so a divergence fails on whichever side drifted. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { initialProfile, needsSetup, sectionFor, setsUsed, templateRows } from "./creds.ts";
import type { CredsInfo, Manifest } from "../shared/types.ts";

const MOCKS = ["mock", "mockllm"];

test("sectionFor mirrors section_for", () => {
  assert.equal(sectionFor("openai/gpt-4o", MOCKS), "openai");
  assert.equal(sectionFor("openai-api/llama/qwen", MOCKS), "llama");
  assert.equal(sectionFor("mockllm/model", MOCKS), null);
  assert.equal(sectionFor("no-slash", MOCKS), null);
  assert.equal(sectionFor("openai-api/", MOCKS), null);
});

const manifest = (params: Manifest["params"]): Manifest => ({ name: "x", params });

test("setsUsed walks bare llm params", () => {
  const m = manifest({ model: { type: { kind: "llm" } } });
  assert.deepEqual(setsUsed(m, { model: "openai/q" }, MOCKS), ["openai"]);
  assert.deepEqual(setsUsed(m, { model: "mock/model" }, MOCKS), []);
  assert.deepEqual(setsUsed(m, {}, MOCKS), []);
});

test("setsUsed walks listOf(struct) and param-wrapped fields", () => {
  const m = manifest({
    players: {
      type: {
        kind: "list",
        of: {
          kind: "struct",
          fields: {
            model: { kind: "llm" },
            /* param-wrapped field (concordia shape): hints around the type */
            judge: { type: { kind: "llm" }, suggestions: ["mock/model"] } as never,
            role: { kind: "enum", values: ["x"] },
          },
        },
      },
    },
  });
  const vals = {
    players: JSON.stringify([
      { model: "openai/gpt", judge: "anthropic/claude", role: "x" },
      { model: "mock/a", role: "x" },
    ]),
  };
  assert.deepEqual(setsUsed(m, vals, MOCKS), ["anthropic", "openai"]);
  /* broken JSON mid-edit routes nowhere rather than throwing */
  assert.deepEqual(setsUsed(m, { players: "[{bro" }, MOCKS), []);
});

const creds = (over: Partial<CredsInfo>): CredsInfo => ({
  runner: true, store: {}, prefs: {},
  providers: { openai: [
    { key: "OPENAI_API_KEY", secret: true, default: "" },
    { key: "OPENAI_BASE_URL", secret: false, default: "https://api.openai.com/v1" },
  ] },
  mock_prefixes: MOCKS,
  ...over,
});

test("templateRows: registry template for built-ins, prefix convention otherwise", () => {
  const c = creds({});
  assert.equal(templateRows("openai", c)[0]!.key, "OPENAI_API_KEY");
  assert.deepEqual(templateRows("llama.cpp", c).map((r) => r.key),
    ["LLAMA_CPP_API_KEY", "LLAMA_CPP_BASE_URL"]);
});

test("initialProfile mirrors the ladder's preselection", () => {
  const store = { openai: { default: {}, work: {} }, llama: { work: {} } };
  const c = creds({ store, prefs: { exp: { openai: "work", llama: "gone" } } });
  assert.equal(initialProfile(c, "exp", "openai"), "work");      /* remembered */
  assert.equal(initialProfile(c, "other", "openai"), "default"); /* default */
  assert.equal(initialProfile(c, "other", "llama"), "work");     /* lone profile */
  assert.equal(initialProfile(c, "exp", "llama"), "work");       /* dangling pref falls through */
  assert.equal(initialProfile(c, "exp", "anthropic"), null);     /* nothing stored */
});

test("needsSetup gates unconfigured built-ins only", () => {
  const c = creds({ store: { llama: { default: {} } } });
  assert.equal(needsSetup("openai", c), true);   /* built-in, unconfigured */
  assert.equal(needsSetup("llama", c), false);   /* configured */
  assert.equal(needsSetup("ollama", c), false);  /* unknown prefix may need nothing */
});
