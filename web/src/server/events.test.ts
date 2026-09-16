import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { envelope } from "../../test/event-fixtures.ts";
import { parseEnvelope } from "../lib/envelope.ts";
import { containsElision, needsDisplayRecord } from "../lib/event-transport.ts";
import { elideEvent, readEventRecords, UnreadableRecord } from "./events.ts";

test("only payload transport fields are elided; envelope and disk record stay intact", () => {
  const record = envelope({ type: "llm.call", input: [{ role: "user", content: "prompt" }],
    call: { request: { messages: ["prompt"] } }, output: { choices: [{ message: { content: "x".repeat(5000) } }] } });
  record.experiment = "e".repeat(5000);
  const original = JSON.stringify(record);
  const transport = elideEvent(record);
  assert.equal(transport.experiment, record.experiment);
  assert.equal(transport.ts, record.ts);
  assert.equal(transport.event.type, "llm.call");
  assert.ok(containsElision(transport.event.input));
  assert.ok(containsElision(transport.event.call));
  assert.ok(needsDisplayRecord(transport));
  assert.ok(!needsDisplayRecord(elideEvent(envelope({ type: "llm.call", input: [], call: { request: {} } }))));
  assert.ok(needsDisplayRecord(elideEvent(envelope({ type: "custom", kind: "roster", data: { name: "x".repeat(5000) } }))));
  assert.equal(JSON.stringify(record), original);
  // Historical wrappers have no special behavior and are never projected.
  const historical = envelope({ type: "llm.call", request: { messages: ["prompt"] }, response: { raw: { result: "reply" } } });
  assert.deepEqual(elideEvent(historical), historical);
});

test("bare events and malformed envelope fields are unreadable, never adapted", () => {
  for (const value of [{ type: "log", seq: 0 }, { ...envelope({ type: "log" }), experiment: undefined },
    { ...envelope({ type: "log" }), seq: -1 }, { ...envelope({ type: "log" }), event: [] },
    { ...envelope({ type: "log" }), ts: "not a time" }])
    assert.throws(() => parseEnvelope(value), /Unreadable/);
});

test("disk lines retain LF, CRLF, no terminator, UTF-8 and original JSON spellings", async () => {
  const root = await mkdtemp(join(tmpdir(), "adb-lines-"));
  try {
    const first = '  {"event":{"type":"custom","kind":"test","data":{"text":"é\\u0041","n":1e0}},"v":0,"schema":0,"experiment":"test","run":"20260916t120000z-012345abcdef","seq":0,"ts":"2026-09-16T12:00:00.000000Z"} ';
    const lines = [first + "\r\n", JSON.stringify(envelope({ type: "log" }, 1)) + "\n", JSON.stringify(envelope({ type: "log" }, 2))];
    await writeFile(join(root, "events.jsonl"), lines.join(""));
    const records = (await readEventRecords(root))!;
    await writeFile(join(root, "events-00001.jsonl"), "not a stream we read\n");
    assert.equal((await readEventRecords(root))!.length, lines.length);
    assert.deepEqual(records.map((item) => item.line), lines);
    assert.deepEqual(Buffer.from(records.map((item) => item.line).join("")), Buffer.from(lines.join("")));
    await writeFile(join(root, "events.jsonl"), '{"type":"log"}\n');
    await assert.rejects(readEventRecords(root), /events.jsonl:1.*Unreadable/);
    await writeFile(join(root, "events.jsonl"), Buffer.from([0xff]));
    await assert.rejects(readEventRecords(root), UnreadableRecord);
  } finally { await rm(root, { recursive: true }); }
});
