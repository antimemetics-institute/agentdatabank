/* Guards for the builder's draft store: drafts round-trip per experiment and
   never bleed across names, an empty save deletes the entry (reset leaves no
   residue), non-string values from a stale/hand-edited blob are dropped, and
   the remembered llm value ignores empties (clearing a field never erases it).
   Runs on the in-memory fallback — node has no localStorage. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { clearDraft, getLastLlm, loadDraft, saveDraft, setLastLlm } from "./run-draft.ts";

test("draft round-trips per experiment, independently", () => {
  saveDraft("hello-chat", { model: "openai/qwen3.5-9b", turns: "4" });
  saveDraft("werewolf", { model: "anthropic/claude-haiku-4-5-20251001" });
  assert.deepEqual(loadDraft("hello-chat"), { model: "openai/qwen3.5-9b", turns: "4" });
  assert.deepEqual(loadDraft("werewolf"), { model: "anthropic/claude-haiku-4-5-20251001" });
  assert.deepEqual(loadDraft("concordia"), {});
});

test("saving again replaces, clearing deletes the entry only for that name", () => {
  saveDraft("hello-chat", { turns: "9" });
  assert.deepEqual(loadDraft("hello-chat"), { turns: "9" });
  clearDraft("hello-chat");
  assert.deepEqual(loadDraft("hello-chat"), {});
  assert.deepEqual(loadDraft("werewolf"), { model: "anthropic/claude-haiku-4-5-20251001" });
});

test("non-string draft values are dropped on load", () => {
  saveDraft("mixed", { ok: "yes", bad: 3 as unknown as string });
  assert.deepEqual(loadDraft("mixed"), { ok: "yes" });
});

test("last llm value: last non-empty wins, empty writes are ignored", () => {
  setLastLlm("openai/qwen3.5-9b");
  setLastLlm("");
  assert.equal(getLastLlm(), "openai/qwen3.5-9b");
  setLastLlm("anthropic/claude-haiku-4-5-20251001");
  assert.equal(getLastLlm(), "anthropic/claude-haiku-4-5-20251001");
});
