/* Result value rendering — ONE chip language for run outputs, used by the run page
   results strip, the runs tables' results column, and the matrix cells/aggregates.
   Booleans → green/red pass-fail chips; numbers → mono chips with units; anything
   else falls back to the shape-aware ParamChip (blobs open the modal). */

import type { RunMeta } from "@/shared/types";
import { ParamChip } from "@/components/param-value";
import { cn } from "@/lib/utils";

const BASE =
  "inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 font-mono text-[11px] leading-5";
const GREEN = "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400";
const RED = "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-400";
const AMBER = "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400";
const NEUTRAL = "bg-muted/50";

export const fmtNum = (v: number): string =>
  Number.isInteger(v) ? String(v) : String(+v.toFixed(3));

export function ResultChip({ name, value, unit }: {
  name: string; value: unknown; unit?: string | null;
}) {
  if (typeof value === "boolean")
    return (
      <span className={cn(BASE, value ? GREEN : RED)}>
        {name} {value ? "✓" : "✗"}
      </span>
    );
  if (typeof value === "number")
    return (
      <span className={cn(BASE, NEUTRAL)}>
        {name} <b className="font-semibold">{fmtNum(value)}</b>
        {unit ? <span className="text-muted-foreground">{unit}</span> : null}
      </span>
    );
  return <ParamChip name={name} value={value} />;
}

/* summary (run.end / run.json) + metric events, deduped by name (summary wins) */
export function ResultChips({ summary, metrics }: {
  summary?: Record<string, unknown>;
  metrics?: { name: string; value: unknown; unit?: string | null }[];
}) {
  const sum = Object.entries(summary ?? {});
  const seen = new Set(sum.map(([k]) => k));
  const extra = (metrics ?? []).filter((m) => !seen.has(m.name));
  if (!sum.length && !extra.length) return null;
  return (
    <>
      {sum.map(([k, v]) => <ResultChip key={k} name={k} value={v} />)}
      {extra.map((m) => <ResultChip key={m.name} name={m.name} value={m.value} unit={m.unit} />)}
    </>
  );
}

/* scorer values flattened to leaves. New streams arrive pre-flattened (the spec's
   flat scalar map); legacy streams carry dict-valued scores (agentharm's
   combined_scorer {score, refusal}) which flatten here with the same '/' join */
export function flattenScores(scores: Record<string, unknown>): { name: string; value: unknown }[] {
  return Object.entries(scores).flatMap(([scorer, v]) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.entries(v as Record<string, unknown>).map(([k, sv]) => ({ name: `${scorer}/${k}`, value: sv }))
      : [{ name: scorer, value: v }]);
}

export interface MetricEv { name: string; value: unknown; unit?: string | null }

/* repeated metric names collapse last-value-wins (the stream convention for
   run-level metrics), keeping the repeat count so nothing hides silently */
export function dedupeMetrics(ms: MetricEv[]): (MetricEv & { count: number })[] {
  const by = new Map<string, MetricEv & { count: number }>();
  for (const m of ms) {
    const prev = by.get(m.name);
    by.set(m.name, { ...m, count: (prev?.count ?? 0) + 1 });
  }
  return [...by.values()];
}

/* read-time aggregate over per-instance scores (instance close-outs), same
   language as AggChips: booleans → colored pass ratio; numerics → neutral mean
   (a 0/1 numeric is NOT judged pass/fail — refusal=1 is good on agentharm's
   harmful split and bad on the benign one); other values → distinct counts.
   Derived at read time, stored nowhere (docs/plan/events.md). */
export function InstanceScoreChips({ scores }: { scores: Record<string, unknown>[] }) {
  const byKey = new Map<string, unknown[]>();
  for (const s of scores)
    for (const { name, value } of flattenScores(s))
      byKey.set(name, [...(byKey.get(name) ?? []), value]);
  return (
    <>
      {[...byKey.entries()].map(([k, vals]) => {
        const n = vals.length;
        if (vals.every((v) => typeof v === "boolean")) {
          const p = vals.filter(Boolean).length;
          const cls = p === n ? GREEN : p === 0 ? RED : AMBER;
          return <span key={k} className={cn(BASE, cls)} title={`${p} of ${n} instances`}>{k} {p}/{n} ✓</span>;
        }
        if (vals.every((v) => typeof v === "number")) {
          const mean = (vals as number[]).reduce((a, b) => a + b, 0) / n;
          return (
            <span key={k} className={cn(BASE, NEUTRAL)} title={`mean over ${n} instances`}>
              {k} x̄ <b className="font-semibold">{fmtNum(mean)}</b>
              <span className="text-muted-foreground">n={n}</span>
            </span>
          );
        }
        const counts = new Map<string, number>();
        for (const v of vals) {
          const s = typeof v === "string" ? v : JSON.stringify(v);
          counts.set(s, (counts.get(s) ?? 0) + 1);
        }
        return (
          <span key={k} className={cn(BASE, NEUTRAL)} title={`${n} instances`}>
            {k}{" "}
            {counts.size <= 3
              ? [...counts.entries()].map(([v, c]) => `${v}×${c}`).join(" ")
              : `×${n} values`}
          </span>
        );
      })}
    </>
  );
}

/* aggregate chips over a set of runs (matrix cells): n, per-boolean pass rates
   (colored by ratio), per-numeric means — same chip language as single results */
export function AggChips({ runs }: { runs: RunMeta[] }) {
  const done = runs.filter((r) => r.phase === "completed");
  const keys = [...new Set(done.flatMap((r) => Object.keys(r.summary ?? {})))];
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <span className={cn(BASE, NEUTRAL, "text-muted-foreground")}>n={runs.length}</span>
      {keys.map((k) => {
        const vals = done.map((r) => (r.summary ?? {})[k]).filter((v) => v !== undefined);
        if (vals.length && vals.every((v) => typeof v === "boolean")) {
          const p = vals.filter(Boolean).length;
          const cls = p === vals.length ? GREEN : p === 0 ? RED : AMBER;
          return <span key={k} className={cn(BASE, cls)}>{k} {p}/{vals.length} ✓</span>;
        }
        if (vals.length && vals.every((v) => typeof v === "number"))
          return (
            <span key={k} className={cn(BASE, NEUTRAL)}>
              {k} x̄ {fmtNum((vals as number[]).reduce((a, b) => a + b, 0) / vals.length)}
            </span>
          );
        return null;
      })}
    </span>
  );
}
