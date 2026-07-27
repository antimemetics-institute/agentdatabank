/* Render guard + the visual iteration loop: every fixture is rendered to
   web/test/diagram-renders/<fixture>-<theme>.svg (gitignored) so a human can
   open the pictures and judge them. The assertions hold the non-visual line:
   output is one well-formed <svg>, hostile text is escaped at the XML boundary,
   and no template hole or object coercion ever leaks into the markup. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { bindScene } from "./bind.ts";
import { layoutScene } from "./layout.ts";
import { DARK, LIGHT, renderSvg } from "./render.ts";
import { concordiaSpec, fixtures } from "./fixtures.ts";

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "test", "diagram-renders");
mkdirSync(outDir, { recursive: true });

const render = (spec: (typeof fixtures)[number]["spec"], params: object, dark = false) =>
  renderSvg(layoutScene(bindScene(spec, params as Record<string, unknown>)), dark ? DARK : LIGHT);

test("every fixture renders to a clean svg in both themes (files written for review)", () => {
  for (const f of fixtures) {
    for (const [theme, dark] of [["light", false], ["dark", true]] as const) {
      const svg = render(f.spec, f.params, dark);
      assert.ok(svg.startsWith("<svg ") && svg.endsWith("</svg>"), `${f.name}: not one <svg>`);
      assert.doesNotMatch(svg, /\{[a-z_][a-z0-9_.]*\}/i, `${f.name}: template hole leaked`);
      assert.ok(!svg.includes("[object"), `${f.name}: object coercion leaked`);
      assert.ok(!svg.includes("NaN") && !svg.includes("undefined"), `${f.name}: bad geometry`);
      writeFileSync(join(outDir, `${f.name}-${theme}.svg`), svg);
    }
  }
});

test("hostile labels come out XML-escaped, structure intact", () => {
  const svg = render(concordiaSpec, {
    agents: [{ name: `] --> <b>&"x"`, goal: `a & b < c`, model: "" }],
    premise: `<script>alert(1)</script>`,
    game_master: "dialogic",
  });
  assert.ok(!svg.includes("<b>") && !svg.includes("<script>"), "raw markup leaked");
  assert.ok(svg.includes("&lt;b&gt;"), "name should be escaped, not dropped");
  /* still one balanced svg element */
  assert.equal((svg.match(/<svg /g) ?? []).length, 1);
  assert.ok(svg.endsWith("</svg>"));
});

test("dark and light renders differ only by palette, not by geometry", () => {
  const f = fixtures[0]!;
  const strip = (s: string) => s.replace(/#[0-9a-f]{6}/gi, "#");
  assert.equal(strip(render(f.spec, f.params, false)), strip(render(f.spec, f.params, true)));
});
