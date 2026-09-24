import { envelope } from "../../test/event-fixtures.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { actorFor, actorLabels, compileSchemas, fieldAt, hintBody, hintValue, htmlToText, renderHint, schemaKinds } from "./render-hints.ts";

test("templates substitute paths only, preserve zero/false, and omit missing values", () => {
  const event = { type: "custom", data: { round: 0, final: false, limit: null } };
  assert.equal(hintValue(event, 'round {data.round} · {data.final} · {data.limit} · {data.missing}'), 'round 0 · false ·  · ');
  assert.equal(hintValue(event, 'data.round'), 0);
  assert.equal(hintValue(event, 'literal words'), 'literal words');
  assert.equal(hintValue(event, '{constructor.name}'), '');
});

test("html-text strips markup and decodes text without executing foreign HTML", () => {
  const html = '<div title="a > b"><strong>USER</strong>: 3 &lt; 4 &amp; &#x1f41f;</div><div>ASSISTANT: <img src=x onerror=evil()>yes<br>done</div><script>evil()</script>';
  assert.equal(htmlToText(html), 'USER: 3 < 4 & 🐟\nASSISTANT: yes\ndone');
  assert.equal(hintBody({ type: 'custom', data: { html } }, { icon: 'file', body: 'data.html', format: 'html-text' }), htmlToText(html));
  assert.equal(htmlToText('&lt;img src=x&gt;'), '<img src=x>'); // remains a text node in React
});

const shared = JSON.parse(readFileSync("../lib/adb-events/adb_events/schema.json", "utf8"));
const custom = {
  $defs: { Message: { properties: { type: { const: "custom" }, kind: { const: "test.message" } },
    "x-adb-render": { icon: "message-circle", actor: "data.person.name", actor_label: "data.label", body: "data.text" } } },
  oneOf: [{ $ref: "#/$defs/Message" }],
};
const definitions = compileSchemas([shared, custom]);

test("actor registries seed silent actors, then row labels apply in transcript order", () => {
  const defs = compileSchemas([shared, custom, { properties: { type: { const: "custom" }, kind: { const: "test.config" } },
    "x-adb-render": { icon: "settings", actor_registry: { path: "data.personas", label: "name" } } }]);
  const row = (id: string, label: unknown) => ({ type: "custom", kind: "test.message", data: { person: { name: id }, label } });
  const events = [
    { type: "llm.call", agent: "persona_0" },
    row("persona_0", "John"), row("persona_0", "John"), row("persona_0", null),
    row("framework", "Mayor"), row("framework", "framework"),
    row("persona_1", ""), row("persona_2", { __elided: { preview: "not a label" } }),
    // The roster may arrive after speaking rows; it still seeds labels first.
    { type: "custom", kind: "test.config", data: { personas: {
      persona_0: { name: "Old name" }, persona_1: { name: "Kate" }, persona_2: { name: "Jack" },
      invalid: { name: "" }, num: 3, array: ["not an entry"],
    } } },
    { type: "custom", kind: "test.config", data: { personas: null } },
  ].map((event, seq) => envelope(event, seq));
  assert.deepEqual([...actorLabels(events, defs)], [["persona_0", "John"], ["persona_1", "Kate"],
    ["persona_2", "Jack"], ["framework", "framework"]]);
});

test("exported schemas supply facets and field-dependent hints", () => {
  assert.deepEqual(schemaKinds(definitions).sort(), ["run.start", "run.end", "llm.call",
    "custom", "result", "status", "log", "stdout", "stderr", "producer.python", "test.message"].sort());
  assert.equal(renderHint({ type: "log", level: "warn" }, definitions)?.icon, "triangle-alert");
  assert.equal(renderHint({ type: "log" }, definitions)?.icon, "info");
  assert.equal(renderHint({ type: "stderr" }, definitions)?.body, "line");
  assert.equal(renderHint({ type: "stdout" }, definitions)?.body, "line");
});

test("custom hints win over the generic shared container; actor uses its declared path", () => {
  const event = { type: "custom", kind: "test.message", data: { person: { name: "Mayor" }, text: "Hello" } };
  assert.equal(actorFor(envelope(event), definitions), "Mayor");
  assert.equal(fieldAt(event, renderHint(event, definitions)?.body), "Hello");
  assert.equal(fieldAt(event, "data.missing.text"), undefined);
  assert.equal(fieldAt(event, "constructor.name"), undefined);
  assert.equal(renderHint({ type: "custom", kind: "new.kind" }, definitions), null);
  assert.equal(actorFor(envelope({ type: "custom", kind: "new.kind", agent: "not a hint" }), definitions), null);
});
