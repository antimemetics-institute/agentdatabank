import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { TopLevelSpec } from "vega-lite";
import type { ExplorationRow } from "@/lib/exploration-data";

export const RunDataContext = createContext<ExplorationRow[] | null>(null);

// Authors use Vega-Lite's grammar directly. The sole ADB convention is a named
// dataset, "runs", containing the same scalar rows used by the run explorer.
export function VegaChart({ spec, horizontalPadding, minPlotWidth = 100 }: { spec: TopLevelSpec; horizontalPadding?: number; minPlotWidth?: number }) {
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
      const plotWidth = () => Math.max(minPlotWidth, host.current!.clientWidth - (horizontalPadding ?? ("facet" in spec ? 40 : 160)));
      const initialWidth = plotWidth();
      const background = dark ? "#09090b" : "#ffffff";
      const foreground = dark ? "#fafafa" : "#18181b";
      const secondary = dark ? "#d4d4d8" : "#3f3f46";
      const markStyles: Record<string, { stroke: string; fill?: string }> = {
        "observation": { stroke: background },
        "summary-interval": { stroke: dark ? "#e4e4e7" : "#475569" },
        "summary-median": { fill: background, stroke: dark ? "#fafafa" : "#334155" },
      };
      const chart = JSON.parse(serialized, (key, value) => {
        if (key === "width" && value === "container") return initialWidth;
        // Expand semantic styles before compilation: explicit mark properties
        // prevent default Vega encodings from replacing the theme colors.
        if (key === "mark" && value && typeof value === "object") {
          const styles: string[] = Array.isArray(value.style) ? value.style : [value.style];
          return { ...Object.assign({}, ...styles.map(style => markStyles[style])), ...value };
        }
        return value;
      });
      const result = await embed(host.current!, chart, {
        renderer: "svg", actions: { export: true, source: false, compiled: false, editor: false },
        config: {
          // Explicit backgrounds also keep exported SVGs readable on their own.
          background,
          axis: { labelLimit: 130, labelColor: secondary, titleColor: foreground, gridColor: dark ? "#3f3f46" : "#e4e4e7", domainColor: dark ? "#71717a" : "#a1a1aa", tickColor: dark ? "#71717a" : "#a1a1aa" },
          header: { labelColor: foreground, titleColor: foreground },
          legend: { labelColor: secondary, titleColor: foreground },
          title: { color: foreground, subtitleColor: secondary },
          text: { color: foreground },
          view: { stroke: null },
        },
      });
      if (!active) { result.finalize(); return; }
      // Facets and concatenations compile their panel widths into separate
      // signals; changing only the outer width leaves those panels clipped.
      const widthSignals = (result.vgSpec.signals ?? []).filter(signal =>
        /(^|_)width$/.test(signal.name) && "value" in signal && signal.value === initialWidth);
      const observer = new ResizeObserver(() => {
        // Measure actual label/header space after layout. Long model labels
        // must remain intact without pushing the rightmost observations offscreen.
        const svgWidth = host.current?.querySelector("svg")?.getBoundingClientRect().width;
        const currentWidth = widthSignals[0] ? Number(result.view.signal(widthSignals[0].name)) : initialWidth;
        const width = horizontalPadding !== undefined && svgWidth && Number.isFinite(currentWidth)
          ? Math.max(minPlotWidth, host.current!.clientWidth - (svgWidth - currentWidth) - 2)
          : plotWidth();
        for (const signal of widthSignals) result.view.signal(signal.name, width);
        void result.view.resize().runAsync();
      });
      observer.observe(host.current!);
      dispose = () => { observer.disconnect(); result.finalize(); };
      setReady(true);
    }).catch((reason: unknown) => { if (active) setError(String(reason)); });
    return () => { active = false; dispose?.(); };
  // Serialized inputs stay stable across identical polling responses.
  }, [serialized, dark, horizontalPadding, minPlotWidth]);
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
