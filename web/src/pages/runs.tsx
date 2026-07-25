/* Runs (#/runs) — the flat run table across all experiments, plus the shared
   RunsTable component the experiment pages reuse. Param filters chosen on
   experiment pages stay scoped to those pages — this tab always shows everything. */

import { useEffect } from "react";
import type { RunMeta } from "@/shared/types";
import {
  displayPhase, fmtVal, groupBy, paramsOf, prefetchRun,
  useRunsPoll, variedKeys,
} from "@/lib/data";
import { navigateWithGlow } from "@/lib/nav";
import { Card } from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { PageLoading, PhaseBadge } from "@/components/bits";
import { ParamChip } from "@/components/param-value";
import { ResultChips } from "@/components/results";

export function RunsPage() {
  const runs = useRunsPoll();
  if (runs === null) return <PageLoading />;
  return (
    <div className="space-y-3">
      <h2 className="text-lg font-semibold">Runs</h2>
      <RunsTable runs={runs} />
    </div>
  );
}

/* #/runs/<rid> — resolve a bare run id (lineage links carry no condition) to the
   full run route once the run list knows it */
export function RunResolver({ rid }: { rid: string }) {
  const runs = useRunsPoll();
  const target = runs?.find((r) => r.run === rid);
  useEffect(() => {
    if (target) location.replace(`#/run/${target.condition}/${target.run}`);
  }, [target]);
  if (runs === null) return <PageLoading />;
  if (!target)
    return (
      <p className="text-sm text-muted-foreground">
        run <span className="font-mono">{rid}</span> is not in this local store —{" "}
        <a href="#/runs">all runs</a>
      </p>
    );
  return <PageLoading />;
}

export function RunsTable({ runs, hideExperiment = false }: { runs: RunMeta[]; hideExperiment?: boolean }) {
  const varied: Record<string, string[]> = {};
  for (const [exp, rs] of Object.entries(groupBy(runs, (r) => r.experiment)))
    varied[exp] = variedKeys(rs);
  const cols = hideExperiment
    ? ["condition", "run", "params", "rep", "phase", "results", "started"]
    : ["condition", "run", "experiment", "params", "rep", "phase", "results", "started"];
  return (
    <Card className="overflow-hidden py-0">
      <Table>
        <TableHeader>
          <TableRow>
            {cols.map((h) => <TableHead key={h}>{h}</TableHead>)}
          </TableRow>
        </TableHeader>
        <TableBody>
          {runs.length === 0 && (
            <TableRow>
              <TableCell colSpan={cols.length} className="text-muted-foreground">no runs match</TableCell>
            </TableRow>
          )}
          {runs.map((r) => {
            const p = paramsOf(r);
            const vk = varied[r.experiment] ?? [];
            const allParams = p
              ? Object.entries(p).map(([k, v]) => `${k}=${fmtVal(v)}`).join("\n")
              : "";
            return (
              <TableRow
                key={`${r.condition}/${r.run}`}
                data-run={r.run}
                className="cursor-pointer"
                onClick={(e) =>
                  /* canonical run link — the bare-id route the runner also prints;
                     the resolver bounces to the full route instantly (list cached) */
                  void navigateWithGlow(e.currentTarget, `#/runs/${r.run}`,
                    () => prefetchRun(r.condition, r.run))}
              >
                <TableCell className="font-mono text-xs">{(r.condition ?? "").slice(0, 12)}</TableCell>
                <TableCell className="font-mono text-xs">{(r.run ?? "").slice(-8)}</TableCell>
                {!hideExperiment && <TableCell>{r.experiment}</TableCell>}
                <TableCell title={allParams}>
                  {!p ? (
                    <span className="text-muted-foreground">…</span>
                  ) : vk.length ? (
                    <span className="flex flex-wrap gap-1">
                      {vk.map((k) => <ParamChip key={k} name={k} value={p[k]} />)}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell>r{String(r.replicate)}</TableCell>
                <TableCell><PhaseBadge phase={displayPhase(r)} /></TableCell>
                <TableCell>
                  <span className="flex flex-wrap gap-1">
                    <ResultChips summary={r.summary} />
                  </span>
                </TableCell>
                <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                  {(r.started_at ?? "").replace("T", " ").slice(0, 19)}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </Card>
  );
}
