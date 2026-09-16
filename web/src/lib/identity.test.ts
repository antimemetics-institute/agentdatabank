import assert from "node:assert/strict";
import test from "node:test";
import { RUN_ID_RE, conditionName } from "./identity.ts";
import { parseEnvelope } from "./envelope.ts";
import { metadataReason } from "./run-readability.ts";
import { envelope } from "../../test/event-fixtures.ts";

test("whole run IDs accept exactly the lowercase UTC-label/random format", () => {
  const valid = "20260916t120000z-012345abcdef";
  for (const run of [valid, "00000000t000000z-000000000000"]) {
    assert.ok(RUN_ID_RE.test(run));
    assert.equal(parseEnvelope({ ...envelope({ type: "log" }), run }).run, run);
  }
  for (const run of ["01M2NHT918HEHKNHE3XTMB0J56", valid.toUpperCase(), valid + "\n",
    valid + "0", valid.slice(1), valid.slice(0, -1), "../" + valid, "012345abcdef"]) {
    assert.ok(!RUN_ID_RE.test(run), run);
    assert.throws(() => parseEnvelope({ ...envelope({ type: "log" }), run }), /envelope.run/);
    assert.match(metadataReason({ run, condition: "test", experiment: "test", state: "completed" })!, /run ID/);
  }
});

test("storage names are built from both recorded fields, with no suffix parsing", () => {
  assert.equal(conditionName("a".repeat(40), "inspect-task-with-hyphens"), "a".repeat(40) + "-inspect-task-with-hyphens");
  assert.throws(() => conditionName("../escape", "test"));
  assert.throws(() => conditionName("test", "../escape"));
});
