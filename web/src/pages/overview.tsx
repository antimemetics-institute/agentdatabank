/* Overview (#/) — a searchable, sortable grid of experiment cards, linking into
   their pages (#/experiments/<name>). Every experiment in the manifest catalog
   gets a card — with zero runs it still appears (summary + a hint), so a fresh
   install shows what's runnable. Sorted by run count by default (the databank's
   center of gravity first). The per-experiment detail (composer, runs) lives on
   the experiment page. */

import { useState } from "react";
import { ArrowRight } from "lucide-react";
import { displayPhase, groupBy, useManifests, useRunsPoll } from "@/lib/data";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageLoading, PHASES, phaseText } from "@/components/bits";

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
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("runs");
  if (runs === null) return <PageLoading />;
  const byExp = groupBy(runs, (r) => r.experiment);
  const byName = new Map((manifests ?? []).map((m) => [m.name, m]));
  /* every catalog experiment (all known experiments), plus any experiment that only
     exists as runs (e.g. its manifest dir is missing in this deployment) */
  const names = [
    ...byName.keys(),
    ...Object.keys(byExp).filter((n) => !byName.has(n)),
  ];
  const lastOf = (n: string) =>
    (byExp[n] ?? []).map((r) => r.started_at ?? "").sort().at(-1) ?? "";
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
        no experiments here — the server needs its manifests dir
        (<code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">ADB_WEB_MANIFESTS</code>,
        set by the nix <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">adb-web</code> wrapper).
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
          const counts: Record<string, number> = {};
          for (const r of rs) counts[displayPhase(r)] = (counts[displayPhase(r)] ?? 0) + 1;
          const last = lastOf(exp);
          return (
            <a key={exp} href={`#/experiments/${encodeURIComponent(exp)}`} className="block no-underline">
              <Card className="flex h-full min-h-40 flex-col transition-colors hover:border-primary/50">
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-start justify-between gap-1.5 text-sm">
                    <span className="break-all font-mono">{exp}</span>
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
                        {PHASES.filter((p) => counts[p]).map((p) => (
                          <span key={p} className={phaseText[p]}>{counts[p]} {p}</span>
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
          );
        })}
      </div>
    </div>
  );
}
