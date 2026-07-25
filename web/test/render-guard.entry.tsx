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
import { renderToStaticMarkup } from "react-dom/server";
import { EventStream } from "../src/components/event-stream";
import { flattenEv } from "../src/lib/data";
import type { Ev } from "../src/shared/types";

const raw = readFileSync(process.env.FIXTURE!, "utf8"); // absolute path from render-check.mjs
const events: Ev[] = raw.split("\n").filter(Boolean).map((l) => flattenEv(JSON.parse(l) as Ev));

const html = renderToStaticMarkup(
  <EventStream events={events} phase="completed" mode="flat" cid="fixturecid" rid="FIXTURERID" />,
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
