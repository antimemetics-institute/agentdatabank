/* Browser-only companion to the SSR guard: React boundaries catch render errors
   in the browser, not during renderToStaticMarkup. Bundle with esbuild and load
   in a page containing <div id="root">; browser-errors.mjs exercises this fixture. */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { RunsTable } from "../src/pages/runs";
import { RunView } from "../src/pages/run";
import { envelope } from "./event-fixtures";
import type { RunMeta } from "../src/shared/types";

const good: RunMeta = { run: "20260916t120000z-000000000006", condition: "corpus", experiment: "corpus",
  state: "completed", summary: { score: 42 } };

function Guard() {
  const [repaired, setRepaired] = useState(false);
  // Simulate an unexpected formatter defect, beyond corrupt JSON that the
  // reader already reports. Each affected row/page must contain this exception.
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const params = repaired ? { value: 1 } : { value: circular };
  const broken = { ...good, run: "20260916t120000z-000000000007", params };
  const events = [envelope({ type: "run.start", params, result_definitions: [] }),
    envelope({ type: "run.end", state: "completed", duration_s: 1, exit_code: 0 }, 1)];
  return <>
    <button onClick={() => setRepaired(true)}>repair fixture</button>
    <section id="row-boundary"><RunsTable runs={[broken, good]} /></section>
    <section id="page-boundary"><RunView cid="corpus" rid="20260916t120000z-000000000007" events={events}
      query="tab=summary" rawRunJson={'{"run":"20260916t120000z-000000000007"}\n'} /></section>
  </>;
}

createRoot(document.getElementById("root")!).render(<Guard />);
