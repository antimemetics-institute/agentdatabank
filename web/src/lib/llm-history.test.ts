import assert from "node:assert/strict";
import test from "node:test";
import { envelope } from "../../test/event-fixtures.ts";
import { historyStart, messageEntries, previousCalls, type ChatMessage } from "./llm-history.ts";

test("previous calls follow each attributed agent's sequence, not arrival or filter order", () => {
  const a = envelope({ type: "llm.call", agent: "a" }, 1), b = envelope({ type: "llm.call", agent: "b" }, 2);
  const next = envelope({ type: "llm.call", agent: "a" }, 8);
  assert.deepEqual([...previousCalls([next, b, a, envelope({ type: "llm.call" }, 9), envelope({ type: "llm.call" }, 10)])], [[8, a]]);
});

test("only a strict structural prefix hides history; resets, equal inputs, and edits show all", () => {
  const old = [{ role: "system", content: "rules" }, { role: "user", content: [{ type: "text", text: "hello" }] }];
  const reordered = [{ content: "rules", role: "system" }, { content: [{ text: "hello", type: "text" }], role: "user" }];
  assert.deepEqual(historyStart([...reordered, { role: "user", content: "next" }], old), { start: 2, differs: false });
  for (const input of [old, old.slice(0, 1), [{ role: "system", content: "different" }, ...old]])
    assert.deepEqual(historyStart(input, old), { start: 0, differs: true });
  assert.deepEqual(historyStart(old), { start: 0, differs: false });
});

test("tool ids join results under requests, including a request in hidden history", () => {
  const messages: ChatMessage[] = [
    { role: "assistant", content: "old text", tool_calls: [
      { id: "one", function: "first", arguments: {} }, { id: "two", function: "second", arguments: { n: 2 } },
    ] },
    { role: "tool", tool_call_id: "two", content: "second result" },
    { role: "tool", tool_call_id: "one", content: "first result" },
    { role: "tool", tool_call_id: "orphan", content: "unmatched" },
  ];
  const original = JSON.stringify(messages);
  const entries = messageEntries(messages, 1);
  assert.deepEqual(entries.map((entry) => [entry.index, entry.contextOnly]), [[0, true], [3, false]]);
  assert.equal(entries[0]!.results.get("one")![0], messages[2]);
  assert.equal(entries[0]!.results.get("two")![0], messages[1]);
  assert.equal(JSON.stringify(messages), original);
});
