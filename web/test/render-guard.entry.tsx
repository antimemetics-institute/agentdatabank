/* Render-quality guard, the fast one: server-render the REAL EventStream over the
   committed fixture of REAL events (a qwen3.5-9b inspect-hello run — block-array
   content, reasoning blocks, elisions: the shapes that once leaked
   "[object Object]") and fail if any coercion artifact reaches the markup.
   Built+run by test/render-check.mjs as part of `pnpm test`. */

// minimal browser shims for module-scope references (lib/data reads
// window.location at import time)
(globalThis as Record<string, unknown>).window = {
  location: { pathname: "/", hash: "#/" },
  addEventListener: () => {},
};
(globalThis as Record<string, unknown>).localStorage = {
  getItem: () => null,
  setItem: () => {},
};

import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { LLMCallFailures } from "../src/components/llm-call-failures";
import { EventStream } from "../src/components/event-stream";
import { ExperimentReadme } from "../src/pages/experiment";
import { ResultChips, ResultRows, ExperimentResults, InstanceScoreChips } from "../src/components/results";
import type { ResultDecl } from "../src/shared/types";
import { flattenEv } from "../src/lib/data";
import type { Ev } from "../src/shared/types";

const raw = readFileSync(process.env.FIXTURE!, "utf8"); // absolute path from render-check.mjs
const events: Ev[] = raw.split("\n").filter(Boolean).map((l) => flattenEv(JSON.parse(l) as Ev));

const html = renderToStaticMarkup(
  <EventStream events={events} state="completed" cid="fixturecid" rid="FIXTURERID" />,
);

const leaks = ["[object Object]", "undefined,undefined", "NaN undefined"]
  .filter((s) => html.includes(s));
if (leaks.length) {
  console.error(`render guard FAILED: markup contains ${leaks.join(", ")}`);
  process.exit(1);
}
if (events.length < 10) {
  console.error("render guard FAILED: fixture suspiciously small");
  process.exit(1);
}
console.log(`render guard ok — ${events.length} real events, ${html.length} chars of markup, no coercion leaks`);

// Failure warnings derive solely from recorded call events, including live
// streams without run.end. Other diagnostics are not failed model calls.
const callEvents: Ev[] = [
  { type: "llm.call", error: { kind: "ConnectionError", message: "offline" } },
  { type: "llm.call", error: null },
  { type: "llm.call", error: { kind: "RateLimitError", message: "busy" } },
  { type: "log", level: "error", message: "unrelated diagnostic" },
];
for (const ending of [[], [{ type: "run.end", state: "completed" }]]) {
  const warning = renderToStaticMarkup(<LLMCallFailures events={[...callEvents, ...ending]} />);
  assert.match(warning, /2\/3 model calls failed/);
}
for (const healthy of [[], [{ type: "llm.call" }], [{ type: "llm.call", error: null }]]) {
  assert.equal(renderToStaticMarkup(<LLMCallFailures events={healthy} />), "");
}

// Optional catalog documentation uses the real safe renderer, including in old
// manifests that predate the field. Raw HTML must remain inert.
for (const readme of [undefined, "", "  \n"]) {
  assert.equal(renderToStaticMarkup(<ExperimentReadme readme={readme} />), "");
}
const readmeHtml = renderToStaticMarkup(<ExperimentReadme readme={
  '# Study\n\nA **documented** experiment.\n\n- First treatment\n\n'
  + '[Paper](https://example.org/paper)\n\n```sh\nadb-runner --describe\n```\n\n'
  + '<script>alert(1)</script>'
} />);
assert.match(readmeHtml, /<details[^>]* open=""/);
assert.match(readmeHtml, /About this experiment/);
assert.match(readmeHtml, /<h3>Study<\/h3>/);
assert.match(readmeHtml, /<b>documented<\/b>/);
assert.match(readmeHtml, /<li>First treatment<\/li>/);
assert.match(readmeHtml, /href="https:\/\/example.org\/paper"/);
assert.match(readmeHtml, /<pre class="code"><code>adb-runner --describe/);
assert.ok(!readmeHtml.includes('<script>'));
assert.match(readmeHtml, /&lt;script&gt;/);
console.log('experiment README render guard ok — optional, rendered Markdown, inert raw HTML');

const definitions: Record<string, ResultDecl> = {
  collapsed: { type: { kind: "bool" }, label: "Resource collapsed", description: "Simulation outcome, not execution failure.", details: "The resource fell below its threshold. <script>unsafe</script>" },
  harvest: { type: { kind: "int" }, label: "Total harvest", unit: "resource units" },
  absent: { type: { kind: "int" }, label: "Not emitted" },
};
const resultHtml = renderToStaticMarkup(<ResultChips definitions={definitions}
  summary={{ collapsed: false, harvest: 50, surprise: 2 }} metrics={[{ name: "harvest", value: 50, unit: "fish" }]} />);
assert.match(resultHtml, /Resource collapsed/);
assert.match(resultHtml, />No<\/b>/);
assert.match(resultHtml, /Total harvest/);
assert.match(resultHtml, />fish<\/span>/);
assert.match(resultHtml, /surprise/);
assert.ok(!resultHtml.includes("Not emitted"));
assert.ok(!/emerald|red-|✓|✗/.test(resultHtml));
const rows = renderToStaticMarkup(<ResultRows definitions={definitions}
  summary={{ collapsed: false, harvest: 50, surprise: 2 }}
  metrics={[{ name: "harvest", value: 10, unit: "kg" }, { name: "harvest", value: 40, unit: "fish" },
    { name: "pool", value: 18 }, { name: "pool", value: 20 }]}
  scores={[{ harvest: 10, refused: false }, { harvest: 30, refused: true }]} />);
assert.equal((rows.match(/data-result-name="harvest"/g) ?? []).length, 1);
assert.equal((rows.match(/data-result-name="pool"/g) ?? []).length, 1);
assert.equal((rows.match(/data-result-name=/g) ?? []).length, 5);
assert.match(rows, />50<\/b>/); // summary wins; latest metric supplies its unit
assert.match(rows, />fish<\/span>/);
assert.ok(!rows.includes(">kg<"));
assert.match(rows, />20<\/b>/); // latest metric value wins
assert.match(rows, /×2/); // repeated metric emission stays visible
assert.match(rows, /mean 20 fish · n=2 instances/); // same-key instance aggregate survives
assert.match(rows, /1\/2 Yes · instances/);
assert.match(rows, /aria-expanded="false"/);
assert.match(rows, /No description provided\./);
assert.ok(!rows.includes("Not emitted"));
assert.ok(!rows.includes("Understanding these results"));
assert.ok(!/<details[^>]* open/.test(rows));
assert.ok(!rows.includes("<script>"));
assert.ok(!rows.includes("unsafe"));
// Descriptions remain visible while optional details are collapsed.
const visibleRows = rows.replace(/<details[\s\S]*?<\/details>/g, "");
assert.match(visibleRows, /Simulation outcome, not execution failure\./);
assert.ok(!visibleRows.includes("The resource fell"));
assert.ok(!visibleRows.includes("Result key:"));
const orderedRows = renderToStaticMarkup(<ResultRows definitions={definitions}
  metrics={[{ name: "pool", value: 3 }, { name: "harvest", value: 5 }, { name: "collapsed", value: false }]} />);
assert.deepEqual([...orderedRows.matchAll(/data-result-name="([^"]+)"/g)].map(m => m[1]), ["collapsed", "harvest", "pool"]);
const rawRow = renderToStaticMarkup(<ResultRows summary={{ pool: 3 }} />);
assert.match(rawRow, /pool/);
assert.match(rawRow, /No description provided\./);
assert.ok(!rawRow.includes("<details")); // nothing useful to expand
assert.equal(renderToStaticMarkup(<ResultRows />), "");
assert.equal(renderToStaticMarkup(<ExperimentResults />), "");
const catalog = renderToStaticMarkup(<ExperimentResults definitions={definitions} />);
assert.match(catalog, /Results this experiment records/);
assert.match(catalog, /Not emitted/);
assert.match(catalog, /Unit: resource units/);
assert.ok(!catalog.includes("text-right")); // catalog rows have no value column
assert.ok(!/<details[^>]* open/.test(catalog));
const scoresHtml = renderToStaticMarkup(<InstanceScoreChips scores={[{ refused: false }, { refused: true }]} />);
assert.ok(!/emerald|red-|✓|✗/.test(scoresHtml));
console.log("result rendering ok — labels, units, neutral booleans, undeclared outputs, unified rows, inline descriptions, optional details, deduplication and catalog");
