import { test } from "node:test";
import assert from "node:assert/strict";
import { explorationRows } from "./exploration-data.ts";
import type { RunMeta } from "../shared/types.ts";

test("exploration retains runs, separates parameters from results, and preserves missing values", () => {
  const first: RunMeta = {
    run: "a", condition: "c", experiment: "example", state: "completed", seed: 7,
    summary: { score: 0, collapsed: false, nested: { x: 1 } },
    result_definitions: [{ name: "unseen", type: { kind: "float" } }],
  };
  const second: RunMeta = { ...first, run: "b", state: "failed", summary: { extra: 2 } };
  const rows = explorationRows([first, second], () => ({ score: 10, model: "a'b", missing: null }));
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.seed, 7);
  assert.ok(!("replicate" in rows[0]!));
  assert.equal(rows[0]!.result_score, 0);
  assert.equal(rows[0]!.result_collapsed, false);
  assert.equal(rows[0]!.param_score, 10);
  assert.equal(rows[0]!.param_model, "a'b");
  assert.equal(rows[0]!.result_extra, null);
  assert.equal(rows[1]!.result_score, null);
  assert.equal(rows[1]!.state, "failed");
  assert.equal(rows[0]!.result_unseen, null);
  assert.equal(rows[0]!.result_nested, null);
  assert.deepEqual(Object.keys(rows[0]!), Object.keys(rows[1]!));
  assert.deepEqual(explorationRows([], () => undefined), []);
});
