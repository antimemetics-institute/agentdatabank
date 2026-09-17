import type { RunMeta } from "@/shared/types";
import { conds, useRunsPoll } from "@/lib/data";
import { conditionHref, siblingConditions, type NamedCondition } from "@/lib/conditions";
import { PageLoading } from "@/components/bits";
import { RunsTable } from "@/pages/runs";
import { ParamChip } from "@/components/param-value";

export function ConditionPage({ cid, query = "" }: { cid: string; query?: string }) {
  const runs = useRunsPoll();
  if (runs === null) return <PageLoading />;
  const conditions = Object.entries(conds).filter(([, c]) => c && typeof c.source === "string"
    && typeof c.experiment === "string" && c.params && typeof c.params === "object" && !Array.isArray(c.params))
    .map(([id, c]) => ({ ...c, id }));
  return <ConditionView cid={cid} query={query} conditions={conditions} runs={runs} />;
}

export function ConditionView({ cid, query = "", conditions, runs }: {
  cid: string; query?: string; conditions: NamedCondition[]; runs: RunMeta[];
}) {
  const anchor = conditions.find((c) => c.id === cid);
  if (!anchor) return <p className="text-muted-foreground">Condition unavailable: <code>{cid}</code></p>;
  const siblings = siblingConditions(anchor, conditions);
  const pool = new URLSearchParams(query).get("pool");
  const members = new Set([cid, ...(pool === null ? [] : siblings.filter((s) => s.key === pool).map((s) => s.condition.id))]);
  const selected = runs.filter((r) => members.has(r.condition));
  return <div className="space-y-5">
    <header>
      <h2 className="text-lg font-semibold">{pool === null ? "Condition" : `Pooled runs · varying ${pool}`}</h2>
      <p className="text-sm text-muted-foreground">{anchor.experiment} · <code>{cid}</code></p>
      <p className="break-all text-xs text-muted-foreground">Source: <code>{anchor.source}</code></p>
      {pool !== null && <a className="text-sm underline" href={conditionHref(cid)}>Back to condition</a>}
    </header>
    {pool === null ? <section className="space-y-2">
      <h3 className="font-medium">Sibling conditions</h3>
      <p className="text-xs text-muted-foreground">Same experiment and source; exactly one parameter differs.</p>
      {siblings.length === 0 ? <p className="text-sm text-muted-foreground">No sibling conditions.</p>
        : <ul className="space-y-2 text-sm">{siblings.map((s) => <li key={s.condition.id} className="flex flex-wrap gap-x-3">
          <code>{s.key}</code><ParamChip value={s.from} /><span>→</span><ParamChip value={s.to} />
          <a className="underline font-mono text-xs" href={conditionHref(s.condition.id)}>{s.condition.id.slice(0, 12)}</a>
          <a className="underline" href={conditionHref(cid, s.key)}>Pool runs varying {s.key}</a>
        </li>)}</ul>}
    </section> : <div className="flex flex-wrap items-center gap-2 text-sm">{members.size} conditions · {selected.length} runs · {pool}: {[
      anchor.params[pool], ...siblings.filter((s) => s.key === pool).map((s) => s.to),
    ].map((value, i) => <ParamChip key={i} value={value} />)}</div>}
    <RunsTable runs={selected} hideExperiment />
  </div>;
}
