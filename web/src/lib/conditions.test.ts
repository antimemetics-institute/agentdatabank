import assert from "node:assert/strict";
import test from "node:test";
import { conditionHref, siblingConditions, type NamedCondition } from "./conditions.ts";
import { hashRoute } from "./run-view.ts";

test("siblings differ in exactly one parameter, within one experiment and fingerprint", () => {
  const anchor: NamedCondition = { id: "a", experiment: "govsim", source: "new", params: { model: "a", threads: 2, nested: { a: 1, b: 2 } } };
  const changed = (id: string, params: NamedCondition["params"]) => ({ ...anchor, id, params: { ...anchor.params, ...params } });
  const siblings = siblingConditions(anchor, [anchor, changed("b", { threads: 3 }), changed("c", { model: "b" }),
    changed("d", { threads: 3, model: "b" }), changed("e", { nested: { b: 2, a: 1 } }),
    { ...changed("f", { threads: 3 }), source: "old" }, { ...changed("g", { threads: 3 }), experiment: "other" }]);
  assert.deepEqual(siblings.map((s) => [s.condition.id, s.key, s.from, s.to]), [["c", "model", "a", "b"], ["b", "threads", 2, 3]]);
});

test("missing and null differ; pool links preserve the parameter name", () => {
  const a = { id: "a", source: "s", experiment: "e", params: {} };
  assert.equal(siblingConditions(a, [{ ...a, id: "b", params: { temperature: null } }])[0]?.key, "temperature");
  const route = hashRoute(conditionHref("abc", "a b/c"));
  assert.deepEqual(route.parts, ["conditions", "abc"]);
  assert.equal(new URLSearchParams(route.query).get("pool"), "a b/c");
});
