/* Experiment page: manifest-driven configuration and optional documentation are
   available even before any runs exist. */

import { displayState, useManifests, useRunsPoll } from "@/lib/data";
import { ExtLinks, MdView, PageLoading, STATES, stateText } from "@/components/bits";
import { dataSource, publishedMode } from "@/lib/data-source";
import { Builder } from "@/components/builder";
import { RunsTable } from "@/pages/runs";
import { ExperimentResults } from "@/components/results";
import { ExperimentNarrative, hasNarrative } from "@/components/experiment-narrative";

export function ExperimentReadme({ readme, name }: { readme?: string; name?: string }) {
  if (!readme?.trim()) return null;
  return (
    <details open className="rounded-md border p-4">
      <summary className="cursor-pointer text-sm font-medium">About this experiment</summary>
      <MdView src={readme} showSourceToggle={false} imageBase={name ? (publishedMode() ? dataSource().asset(`index/catalog/assets/${encodeURIComponent(name)}/`) : `/api/experiments/${encodeURIComponent(name)}/assets/`) : undefined}
        className="experiment-readme mt-3 min-w-0 [overflow-wrap:anywhere]" />
    </details>
  );
}

export function ExperimentPage({ name }: { name: string }) {
  const runs = useRunsPoll();
  const manifest = useManifests()?.find((m) => m.name === name);
  const rs = (runs ?? []).filter((r) => r.experiment === name);
  const counts: Record<string, number> = {};
  for (const r of rs) counts[displayState(r)] = (counts[displayState(r)] ?? 0) + 1;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline gap-4">
        <h2 className="text-lg font-semibold">{name}</h2>
        <ExtLinks links={manifest?.links} />
        <span className="flex flex-wrap gap-3 text-xs">
          {STATES.filter((p) => counts[p]).map((p) => (
            <span key={p} className={stateText[p]}>{counts[p]} {p}</span>
          ))}
        </span>
      </div>

      {hasNarrative(name) ? <ExperimentNarrative name={name} runs={runs === null ? null : rs} />
        : <ExperimentReadme readme={manifest?.readme} name={name} />}
      <ExperimentResults definitions={manifest?.results} />
      {!publishedMode() && <Builder name={name} />}

      {runs === null ? <PageLoading /> : rs.length ? (
        <RunsTable runs={rs} hideExperiment />
      ) : (
        <p className="text-sm text-muted-foreground">no runs yet for <b>{name}</b>.</p>
      )}
    </div>
  );
}
