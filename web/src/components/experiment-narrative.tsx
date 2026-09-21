import { Component, Suspense, lazy, type ReactNode } from "react";
import pages from "virtual:experiment-pages";
import type { RunMeta } from "@/shared/types";
import { VegaChart, RunDataContext } from "@/components/vega-chart";
import { GovSimFigure } from "@/components/govsim-figure";
import { explorationRows } from "@/lib/exploration-data";
import { paramsOf } from "@/lib/data";

const compiled = Object.fromEntries(Object.entries(pages).map(([name, load]) => [name, lazy(load)]));
export const hasNarrative = (name: string) => name in compiled;

class NarrativeBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <p role="alert">Could not display this experiment’s narrative.</p> : this.props.children; }
}

export function ExperimentNarrative({ name, runs }: { name: string; runs: RunMeta[] | null }) {
  const Page = compiled[name];
  if (!Page) return null;
  return <section className="experiment-readme rounded-md border p-5" aria-label="About this experiment">
    <NarrativeBoundary key={name}><Suspense fallback={<p>Loading experiment…</p>}>
      <RunDataContext value={runs === null ? null : explorationRows(runs, paramsOf)}>
        <div className="md narrative"><Page components={{ VegaChart, GovSimFigure }} /></div>
      </RunDataContext>
    </Suspense></NarrativeBoundary>
  </section>;
}
