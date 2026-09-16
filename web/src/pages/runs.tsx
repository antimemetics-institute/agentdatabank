/* Runs (#/runs) — the flat run table across all experiments, plus the shared
   RunsTable component the experiment pages reuse. Param filters chosen on
   experiment pages stay scoped to those pages — this tab always shows everything. */

import { useEffect } from "react";
import type { RunMeta } from "@/shared/types";
import {
  displayState, fmtVal, groupBy, paramsOf, prefetchRun,
  useRunsPoll, variedKeys,
} from "@/lib/data";
import { navigateWithGlow } from "@/lib/nav";
import { Card } from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { PageLoading, StateBadge } from "@/components/bits";
import { ParamChip } from "@/components/param-value";
import { RenderBoundary, UnreadableBadge, displayRun } from "@/components/read-errors";
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
export function RunResolver({ rid, query = "" }: { rid: string; query?: string }) {
  const runs = useRunsPoll();
  const target = runs?.find((r) => r.run === rid);
  useEffect(() => {
    if (target) location.replace(`#/run/${target.condition}/${target.run}${query ? `?${query}` : ""}`);
  }, [target, query]);
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

export function RunsTable({ runs: suppliedRuns, hideExperiment = false }: { runs: RunMeta[]; hideExperiment?: boolean }) {
  const runs = (Array.isArray(suppliedRuns) ? suppliedRuns : []).map(displayRun);
  const varied: Record<string, string[]> = Object.create(null);
  for (const [exp, rs] of Object.entries(groupBy(runs, (r) => r.experiment))) {
    // Parameter comparison is optional context. A bad parameter value is exposed
    // by its own row boundary, without preventing neighboring rows from rendering.
    try { varied[exp] = variedKeys(rs.filter((r) => r.readable !== false)); }
    catch { varied[exp] = []; }
  }
  const cols = hideExperiment
    ? ["condition", "run", "params", "state", "results", "started"]
    : ["condition", "run", "experiment", "params", "state", "results", "started"];
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
          {runs.map((r) => <RenderBoundary key={`${r.condition}/${r.run}`} resetKey={r}
            fallback={(reason) => <UnreadableRow run={r} reason={reason} columns={cols.length} />}>
            {r.readable === false ? <UnreadableRow run={r} reason={r.reason!} columns={cols.length} />
              : <RunRow run={r} varied={varied[r.experiment] ?? []} hideExperiment={hideExperiment} />}
          </RenderBoundary>)}
        </TableBody>
      </Table>
    </Card>
  );
}

function UnreadableRow({ run, reason, columns }: { run: RunMeta; reason: string; columns: number }) {
  return <TableRow data-run={run.run}>
    <TableCell colSpan={columns}>
      <a href={`#/run/${encodeURIComponent(run.condition)}/${encodeURIComponent(run.run)}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <UnreadableBadge /><code className="text-xs">{run.run}</code>
        <span className="text-xs text-muted-foreground">{reason}</span>
      </a>
    </TableCell>
  </TableRow>;
}

function RunRow({ run: r, varied, hideExperiment }: { run: RunMeta; varied: string[]; hideExperiment: boolean }) {
  const p = paramsOf(r);
  const vk = varied;
  const allParams = p
    ? Object.entries(p).map(([k, v]) => `${k}=${fmtVal(v)}`).join("\n")
    : "";
  return (
    <TableRow
      data-run={r.run}
      className="cursor-pointer"
      onClick={(e) =>
        /* canonical run link — the bare-id route the runner also prints;
           the resolver bounces to the full route instantly (list cached) */
        void navigateWithGlow(e.currentTarget, `#/runs/${r.run}`,
          () => prefetchRun(r.condition, r.run))}
    >
      <TableCell className="font-mono text-xs">{(r.condition ?? "").slice(0, 12)}</TableCell>
      <TableCell className="font-mono text-xs">{r.run}</TableCell>
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
      <TableCell><StateBadge state={displayState(r)} /></TableCell>
      <TableCell>
        <span className="flex flex-wrap gap-1">
          <ResultChips summary={r.summary} definitions={r.result_definitions} />
        </span>
      </TableCell>
      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
        {(r.started_at ?? "").replace("T", " ").slice(0, 19)}
      </TableCell>
    </TableRow>
  );
}
