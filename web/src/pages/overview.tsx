/* Overview (#/) — a searchable, sortable grid of experiment cards, linking into
   their pages (#/experiments/<name>). Every experiment in the manifest catalog
   gets a card — with zero runs it still appears (summary + a hint), so a fresh
   install shows what's runnable. Sorted by run count by default (the databank's
   center of gravity first). An experiment directory's optional thumbnail.<ext>
   tops its card. The per-experiment detail (composer, runs) lives on the
   experiment page. */

import { useState } from "react";
import thumbnails from "virtual:experiment-thumbnails";
import type { RunMeta, Manifest } from "@/shared/types";
import { RenderBoundary, UnreadableRunLink, displayRun } from "@/components/read-errors";
import { ArrowRight } from "lucide-react";
import { displayState, groupBy, useManifests, useRunsPoll } from "@/lib/data";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageLoading, STATES, stateText } from "@/components/bits";

const INPUT =
  "w-full max-w-md rounded-lg border bg-background px-3 py-1.5 text-sm " +
  "outline-none focus:ring-2 focus:ring-ring";

const SORTS = {
  runs: "most runs",
  recent: "recently run",
  name: "name",
} as const;
type Sort = keyof typeof SORTS;

export function OverviewPage() {
  const runs = useRunsPoll();
  const manifests = useManifests();
  if (runs === null) return <PageLoading />;
  return <OverviewView runs={runs} manifests={manifests ?? []} />;
}

export function OverviewView({ runs: suppliedRuns, manifests }: { runs: RunMeta[]; manifests: Manifest[] }) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("runs");
  const runs = (Array.isArray(suppliedRuns) ? suppliedRuns : []).map(displayRun);
  const byExp = groupBy(runs, (r) => r.experiment);
  const byName = new Map((Array.isArray(manifests) ? manifests : []).map((m) => [m.name, m]));
  /* every catalog experiment (all known experiments), plus any experiment that only
     exists as runs (e.g. its manifest dir is missing in this deployment) */
  const names = [
    ...byName.keys(),
    ...Object.keys(byExp).filter((n) => !byName.has(n)),
  ];
  const lastOf = (n: string) =>
    (byExp[n] ?? []).map((r) => typeof r.started_at === "string" ? r.started_at : "").sort().at(-1) ?? "";
  const q = query.trim().toLowerCase();
  const shown = (q
    ? names.filter((n) =>
        n.toLowerCase().includes(q) ||
        (byName.get(n)?.summary ?? "").toLowerCase().includes(q))
    : names
  ).sort((a, b) =>
    (sort === "runs" && (byExp[b]?.length ?? 0) - (byExp[a]?.length ?? 0)) ||
    (sort === "recent" && lastOf(b).localeCompare(lastOf(a))) ||
    a.localeCompare(b));
  if (!names.length)
    return (
      <p className="text-sm text-muted-foreground">
        No experiments are available in this catalog.
      </p>
    );
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Experiments</h2>
        <div className="flex flex-1 items-center justify-end gap-2">
          <input
            type="search"
            className={INPUT}
            placeholder="search experiments…"
            value={query}
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select
            className="rounded-lg border bg-background px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
            value={sort}
            title="sort experiments"
            onChange={(e) => setSort(e.target.value as Sort)}
          >
            {Object.entries(SORTS).map(([k, label]) => (
              <option key={k} value={k}>{label}</option>
            ))}
          </select>
        </div>
      </div>
      {!shown.length && (
        <p className="text-sm text-muted-foreground">nothing matches “{query}”.</p>
      )}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {shown.map((exp) => {
          const rs = byExp[exp] ?? [];
          const summary = byName.get(exp)?.summary;
          const thumbnail = thumbnails[exp];
          const counts: Record<string, number> = {};
          for (const r of rs) counts[displayState(r)] = (counts[displayState(r)] ?? 0) + 1;
          const last = lastOf(exp);
          return (
            <div key={exp} className="space-y-2">
              <a href={`#/experiments/${encodeURIComponent(exp)}`} className="block no-underline">
                <Card className={`flex h-full min-h-40 flex-col overflow-hidden transition-colors hover:border-primary/50 ${thumbnail ? "pt-0" : ""}`}>
                  {thumbnail && (
                    <img src={thumbnail} alt="" loading="lazy"
                      className="aspect-[2/1] w-full border-b bg-white object-contain" />
                  )}
                  <CardHeader className="pb-2">
                    <CardTitle className="flex items-start justify-between gap-1.5 text-sm">
                      <span className="flex min-w-0 items-start gap-1.5">
                        <span className="break-all font-mono">{exp}</span>
                      </span>
                      <ArrowRight className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="flex flex-1 flex-col gap-2">
                    {summary && (
                      <p className="line-clamp-3 text-xs text-muted-foreground">{summary}</p>
                    )}
                    <div className="mt-auto flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      {rs.length ? (
                        <>
                          <span className="font-medium text-foreground">
                            {rs.length} {rs.length === 1 ? "run" : "runs"}
                          </span>
                          {STATES.filter((p) => counts[p]).map((p) => (
                            <span key={p} className={stateText[p]}>{counts[p]} {p}</span>
                          ))}
                          {last && <span>last {last.replace("T", " ").slice(5, 16)}</span>}
                        </>
                      ) : (
                        <span>no runs yet</span>
                      )}
                    </div>
                  </CardContent>
                </Card>
              </a>
              {rs.filter((run) => run.readable === false).map((run) => <RenderBoundary key={`${run.condition}/${run.run}`} resetKey={run}
                fallback={(reason) => <UnreadableRunLink run={run} reason={reason} />}>
                <UnreadableRunLink run={run} reason={run.reason!} />
              </RenderBoundary>)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
