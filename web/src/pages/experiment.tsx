/* Experiment page (#/experiments/<name>) — phase counts, the run-config builder,
   and the experiment's runs table. (No conditions table in this version: runs carry
   their condition hash, visible on the run detail page, but the GUI does not yet
   group or aggregate by condition.) */

import { displayPhase, useRunsPoll } from "@/lib/data";
import { PageLoading, PHASES, phaseText } from "@/components/bits";
import { Builder } from "@/components/builder";
import { RunsTable } from "@/pages/runs";

export function ExperimentPage({ name }: { name: string }) {
  const runs = useRunsPoll();

  const rs = (runs ?? []).filter((r) => r.experiment === name);

  /* the builder (manifest-driven, needs no runs) always shows; the runs table
     appears once this experiment has runs */
  const header = (
    <div className="flex flex-wrap items-baseline gap-4">
      <h2 className="text-lg font-semibold">{name}</h2>
    </div>
  );
  if (runs === null)
    return <div className="space-y-4">{header}<Builder name={name} /><PageLoading /></div>;
  if (!rs.length)
    return (
      <div className="space-y-4">
        {header}
        <Builder name={name} />
        <p className="text-sm text-muted-foreground">no runs yet for <b>{name}</b>.</p>
      </div>
    );

  const counts: Record<string, number> = {};
  for (const r of rs) counts[displayPhase(r)] = (counts[displayPhase(r)] ?? 0) + 1;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline gap-4">
        <h2 className="text-lg font-semibold">{name}</h2>
        <span className="flex flex-wrap gap-3 text-xs">
          {PHASES.filter((p) => counts[p]).map((p) => (
            <span key={p} className={phaseText[p]}>{counts[p]} {p}</span>
          ))}
        </span>
      </div>

      <Builder name={name} />

      <RunsTable runs={rs} hideExperiment />
    </div>
  );
}
