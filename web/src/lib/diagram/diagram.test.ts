/* Binding + layout invariants for the diagram prototype. The load-bearing ones:
   templates never leak braces into a picture, cast size drives instance count
   1:1 (the builder's live-edit contract), hostile labels stay labels, and no
   two footprints overlap at any fixture size. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { bindScene, fill } from "./bind.ts";
import { layoutScene } from "./layout.ts";
import { concordiaSpec, fixtures } from "./fixtures.ts";
import type { Params } from "./spec.ts";

const cafe = fixtures.find((f) => f.name === "concordia-cafe")!.params;
const market = fixtures.find((f) => f.name === "concordia-market")!.params;

test("forEach expands one node per roster row, ids indexed", () => {
  const scene = bindScene(concordiaSpec, market);
  const cast = scene.nodes.filter((n) => n.kind === "agent");
  assert.equal(cast.length, 4);
  assert.deepEqual(cast.map((n) => n.id), ["cast.0", "cast.1", "cast.2", "cast.3"]);
  assert.deepEqual(cast.map((n) => n.label), ["Mara", "Tomas", "Ines", "Rook"]);
});

test("adding a roster row adds exactly one agent node and one flow", () => {
  const grown: Params = {
    ...market,
    agents: [...(market.agents as unknown[]), { name: "Nia", goal: "Observe.", model: "" }],
  };
  const before = bindScene(concordiaSpec, market);
  const after = bindScene(concordiaSpec, grown);
  assert.equal(
    after.nodes.filter((n) => n.kind === "agent").length,
    before.nodes.filter((n) => n.kind === "agent").length + 1,
  );
  assert.equal(after.flows.length, before.flows.length + 1);
});

test("explicit override wins; empty override inherits the run default", () => {
  const scene = bindScene(concordiaSpec, market);
  const [mara, , , rook] = scene.nodes.filter((n) => n.kind === "agent");
  assert.equal(mara!.badge, "openai/qwen3.5-9b");
  /* roster model: "" means "use the run's model" — the picture shows the
     resolved reality, not the raw override field */
  assert.equal(rook!.badge, "mock/model");
});

test("badge is dropped only when nothing resolves anywhere", () => {
  const scene = bindScene(concordiaSpec, {
    agents: [{ name: "Nia", goal: "g", model: "" }], // and no run-level model at all
  });
  assert.equal(scene.nodes[0]!.badge, undefined);
});

test("unresolvable holes render empty — braces never leak", () => {
  assert.equal(fill("run of {nope.deep} done", {}), "run of  done");
  const scene = bindScene(concordiaSpec, { agents: [{ name: "Solo" }] });
  for (const n of scene.nodes) {
    assert.doesNotMatch(n.label, /\{[^}]*\}/);
    assert.doesNotMatch(n.detail ?? "", /\{[^}]*\}/);
  }
});

test("object-valued holes render empty, never [object Object]", () => {
  assert.equal(fill("{agents}", cafe), "");
});

test("absent or mistyped forEach list yields no instances, no crash", () => {
  const scene = bindScene(concordiaSpec, { premise: "p", agents: "not-a-list" });
  assert.equal(scene.nodes.filter((n) => n.kind === "agent").length, 0);
  /* wildcard flows over zero instances vanish; gm→world survives */
  assert.deepEqual(scene.flows.map((f) => f.from), ["gm"]);
});

test("flows connect roles only — instance refs are unsayable", () => {
  const spec = {
    ...concordiaSpec,
    flows: [...(concordiaSpec.flows ?? []), { from: "cast.1", to: "cast.3" }],
  };
  const scene = bindScene(spec, market);
  /* the instance-targeted flow silently vanishes; the role-level ones remain */
  assert.ok(!scene.flows.some((f) => f.from === "cast.1" && f.to === "cast.3"));
  assert.equal(scene.flows.filter((f) => f.to === "world").length, 5); // 4 cast + gm
});

test("a hostile name is just a label at bind time", () => {
  const scene = bindScene(concordiaSpec, {
    ...cafe,
    agents: [{ name: `] --> <b>&"x"</b>`, goal: "break the diagram", model: "" }],
  });
  assert.equal(scene.nodes[0]!.label, `] --> <b>&"x"</b>`);
});

test("layout: no two footprints overlap, canvas contains everything", () => {
  for (const f of fixtures) {
    const scene = layoutScene(bindScene(f.spec, f.params));
    for (const n of scene.nodes) {
      assert.ok(n.x >= 0 && n.y >= 0, `${f.name}: ${n.id} off-canvas`);
      assert.ok(n.x + n.w <= scene.w && n.y + n.h <= scene.h, `${f.name}: ${n.id} clipped`);
    }
    for (let i = 0; i < scene.nodes.length; i++)
      for (let j = i + 1; j < scene.nodes.length; j++) {
        const a = scene.nodes[i]!;
        const b = scene.nodes[j]!;
        const apart =
          a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
        assert.ok(apart, `${f.name}: ${a.id} overlaps ${b.id}`);
      }
  }
});

test("layout: 7-agent cast wraps to two rows (taller canvas, same width class)", () => {
  const four = layoutScene(bindScene(concordiaSpec, market));
  const seven = layoutScene(
    bindScene(concordiaSpec, fixtures.find((f) => f.name === "concordia-crowd")!.params),
  );
  assert.ok(seven.h > four.h, "second cast row must grow the canvas");
  const rows = new Set(
    seven.nodes.filter((n) => n.kind === "agent").map((n) => n.y),
  );
  assert.equal(rows.size, 2);
});

test("layout: pipeline stages run left to right in spec order", () => {
  const f = fixtures.find((x) => x.name === "inspect-pipeline")!;
  const scene = layoutScene(bindScene(f.spec, f.params));
  const xs = ["data", "solver", "scorer"].map(
    (id) => scene.nodes.find((n) => n.id === id)!.x,
  );
  assert.ok(xs[0]! < xs[1]! && xs[1]! < xs[2]!);
});
