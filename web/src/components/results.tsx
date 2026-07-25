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
