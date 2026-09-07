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
import { EventStream } from "../src/components/event-stream";
import { ExperimentReadme } from "../src/pages/experiment";
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
