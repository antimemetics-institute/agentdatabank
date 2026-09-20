import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { TopLevelSpec } from "vega-lite";
import type { ExplorationRow } from "@/lib/exploration-data";

export const RunDataContext = createContext<ExplorationRow[] | null>(null);

// Authors use Vega-Lite's grammar directly. The sole ADB convention is a named
// dataset, "runs", containing the same scalar rows used by the run explorer.
export function VegaChart({ spec }: { spec: TopLevelSpec }) {
  const rows = useContext(RunDataContext);
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const [dark, setDark] = useState(document.documentElement.classList.contains("dark"));
  const serialized = JSON.stringify({ ...spec, datasets: { ...spec.datasets, runs: rows ?? [] } });
  useEffect(() => {
    const observer = new MutationObserver(() => setDark(document.documentElement.classList.contains("dark")));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!rows?.length) return;
    let active = true;
    let dispose: (() => void) | undefined;
    setError(""); setReady(false);
    void import("vega-embed").then(async ({ default: embed }) => {
      if (!active) return;
      // Vega-Lite concatenations do not support fit-x autosizing. Reserve room
      // for labels and size their shared plotting width from the actual host.
      const plotWidth = () => Math.max(100, host.current!.clientWidth - 160);
      const chart = JSON.parse(serialized, (key, value) => key === "width" && value === "container" ? plotWidth() : value);
      const result = await embed(host.current!, chart, {
        renderer: "svg", actions: { export: true, source: false, compiled: false, editor: false },
        config: {
          background: "transparent",
          axis: { labelLimit: 130, labelColor: dark ? "#d4d4d8" : "#3f3f46", titleColor: dark ? "#fafafa" : "#18181b", gridColor: dark ? "#3f3f46" : "#e4e4e7" },
          legend: { labelColor: dark ? "#d4d4d8" : "#3f3f46", titleColor: dark ? "#fafafa" : "#18181b" },
          title: { color: dark ? "#fafafa" : "#18181b" },
          view: { stroke: null },
        },
      });
      if (!active) { result.finalize(); return; }
      const observer = new ResizeObserver(() => { void result.view.width(plotWidth()).resize().runAsync(); });
      observer.observe(host.current!);
      dispose = () => { observer.disconnect(); result.finalize(); };
      setReady(true);
    }).catch((reason: unknown) => { if (active) setError(String(reason)); });
    return () => { active = false; dispose?.(); };
  // Serialized inputs stay stable across identical polling responses.
  }, [serialized, dark]);
  return <figure className="vega-figure">
    {rows === null ? <p>Loading run data…</p> : !rows.length ? <p>No recorded runs yet. This figure will appear after a run.</p> : <>
      {!ready && !error && <p role="status">Loading chart…</p>}
      {error && <p role="alert">Could not draw this chart: {error}</p>}
      <div ref={host} className="vega-host" />
      <details className="mt-2 text-xs text-muted-foreground">
        <summary className="cursor-pointer">Chart specification</summary>
        <p>Vega-Lite specification with the displayed run data. You can edit it in a Vega-Lite editor or give it to an agent.</p>
        <button className="underline" onClick={() => {
          const url = URL.createObjectURL(new Blob([JSON.stringify(JSON.parse(serialized), null, 2)], { type: "application/json" }));
          const link = document.createElement("a"); link.href = url; link.download = "chart.vl.json"; link.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        }}>Download specification and data</button>
        <pre className="mt-2 max-h-72 overflow-auto text-xs">{JSON.stringify(spec, null, 2)}</pre>
      </details>
    </>}
  </figure>;
}
