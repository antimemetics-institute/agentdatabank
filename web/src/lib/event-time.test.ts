import { envelope } from "../../test/event-fixtures.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { buildGutters } from "./event-time.ts";

test("every row retains its microseconds and dims only the unchanged prefix", () => {
  const rows = ["12:00:00.123456", "12:00:00.123457", "12:00:00.123457", "12:00:01.000000"]
    .map((time, seq) => envelope({ type: "log" }, seq, `2026-09-15T${time}Z`));
  const gutters = [...buildGutters(rows, "absolute").values()];
  assert.deepEqual(gutters.map((g) => g.unchanged), [0, 14, 15, 7]);
  assert.ok(gutters.every((g) => g.label.length === 15));
  assert.equal(gutters[2]!.label, "12:00:00.123457");
  assert.match(gutters[1]!.title, /2026-09-15T12:00:00.123457Z · \+00:00:00.000001 from run start/);
});

test("filtered and relative views keep the original run start", () => {
  const start = "2026-09-15T12:00:00.000000Z";
  const [gutter] = [...buildGutters([envelope({ type: "log" }, 2, "2026-09-15T13:01:02.000003Z")], "relative", start).values()];
  assert.equal(gutter!.label, "+01:01:02.000003");
  assert.match(gutter!.title, /13:01:02.000003Z/);
});

// An experiment's clock is data, never the viewer's capture clock.
test("a payload ts cannot replace capture time", () => {
  const record = envelope({ type: "custom", kind: "clock.test", ts: "1999-01-01T00:00:00Z" }, 4,
    "2026-09-16T12:34:56.123456Z");
  const gutter = buildGutters([record], "absolute").get(4)!;
  assert.equal(gutter.label, "12:34:56.123456");
  assert.match(gutter.title, /2026-09-16T12:34:56.123456Z/);
  assert.ok(!gutter.title.includes("1999"));
});
