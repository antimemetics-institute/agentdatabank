/* Result rows for run and experiment detail pages; compact chips for listings
   and matrix aggregates. Booleans stay neutral; structured values open a modal. */

import { useState } from "react";
import type { RunMeta, ResultDecl } from "@/shared/types";
import { ParamChip } from "@/components/param-value";
import { cn } from "@/lib/utils";

const BASE =
  "inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 font-mono text-[11px] leading-5";
const NEUTRAL = "bg-muted/50";

export const fmtNum = (v: number): string =>
  Number.isInteger(v) ? String(v) : String(+v.toFixed(3));

/* Shared rows keep the explanation beside its result. Catalog rows omit values. */
export function ResultRows({ definitions, summary, metrics = [], scores = [], catalog = false }: {
  definitions?: Record<string, ResultDecl>;
  summary?: Record<string, unknown>;
  metrics?: MetricEv[];
  scores?: Record<string, unknown>[];
  catalog?: boolean;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const latest = new Map(dedupeMetrics(metrics).map(m => [m.name, m]));
  const instanceValues = new Map<string, unknown[]>();
  for (const score of scores)
    for (const { name, value } of flattenScores(score))
      instanceValues.set(name, [...(instanceValues.get(name) ?? []), value]);
  const emitted = new Set([...Object.keys(summary ?? {}), ...latest.keys(), ...instanceValues.keys()]);
  const declared = Object.keys(definitions ?? {});
  const names = catalog ? declared
    : [...declared.filter(name => emitted.has(name)), ...[...emitted].filter(name => !Object.hasOwn(definitions ?? {}, name))];
  if (!names.length) return null;
  return (
    <dl className={cn("divide-y", !catalog && "result-value-rows")} data-result-rows="">
      {names.map(name => {
        const definition = definitions?.[name];
        const label = definition?.label || name;
        const metric = latest.get(name);
        const unit = metric?.unit ?? definition?.unit;
        const hasValue = Object.hasOwn(summary ?? {}, name) || latest.has(name);
        const value = Object.hasOwn(summary ?? {}, name) ? summary![name] : metric?.value;
        const vals = instanceValues.get(name);
        const details = definition?.details?.trim();
        return (
          <div key={name} data-result-name={name} className="relative grid items-baseline py-2.5 first:pt-0 last:pb-0">
              <dt className="result-label text-sm font-medium [overflow-wrap:anywhere]">
                {details ? <button type="button" aria-expanded={Boolean(expanded[name])}
                  onClick={() => setExpanded(previous => ({ ...previous, [name]: !previous[name] }))}
                  className={cn("inline-flex max-w-full items-baseline gap-2 text-left hover:underline", !catalog && "sm:text-right")}>
                  <span aria-hidden="true" className="text-muted-foreground">{expanded[name] ? "▾" : "▸"}</span>
                  <span>{label}</span>
                </button> : label}
              </dt>
              {!catalog && (
                <dd className="result-value min-w-0 space-y-1 text-left font-mono text-sm [overflow-wrap:anywhere]">
                  {hasValue && <div>
                    <ResultValue value={value} />
                    {unit && <span className="ml-1 text-muted-foreground">{unit}</span>}
                    {(metric?.count ?? 0) > 1 && <span className="ml-2 text-muted-foreground" title="Same-named metric re-emitted; last value shown">×{metric!.count}</span>}
                  </div>}
                  {vals && <div className="text-muted-foreground">{instanceSummary(vals, unit)}</div>}
                </dd>
              )}
            {catalog && unit && <dd className="mt-0.5 text-xs text-muted-foreground">Unit: {unit}</dd>}
            <dd className="result-description mt-1 whitespace-pre-line text-sm text-muted-foreground [overflow-wrap:anywhere]">
              {definition?.description?.trim() || "No description provided."}
            </dd>
            {details && expanded[name] && <dd className="result-details mt-2 space-y-2 text-xs text-muted-foreground [overflow-wrap:anywhere]">
              <p className="whitespace-pre-line leading-relaxed">{details}</p>
              <p>Result key: <code>{name}</code></p>
            </dd>}
          </div>
        );
      })}
    </dl>
  );
}

function ResultValue({ value }: { value: unknown }) {
  if (typeof value === "boolean") return <b className="font-semibold">{value ? "Yes" : "No"}</b>;
  if (typeof value === "number") return <b className="font-semibold">{fmtNum(value)}</b>;
  if (typeof value === "string" && value.length <= 64 && !value.includes("\n")) return <span>{value}</span>;
  return <ParamChip value={value} />;
}

function instanceSummary(vals: unknown[], unit?: string | null): string {
  const n = vals.length;
  if (vals.every(v => typeof v === "boolean")) return `${vals.filter(Boolean).length}/${n} Yes · instances`;
  if (vals.every(v => typeof v === "number"))
    return `mean ${fmtNum((vals as number[]).reduce((a, b) => a + b, 0) / n)}${unit ? ` ${unit}` : ""} · n=${n} instances`;
  const counts = new Map<string, number>();
  for (const value of vals) {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    counts.set(text, (counts.get(text) ?? 0) + 1);
  }
  return `${counts.size <= 3 ? [...counts].map(([v, c]) => `${v}×${c}`).join(" · ") : `${counts.size} distinct values`} · n=${n} instances`;
}

export function ExperimentResults({ definitions }: { definitions?: Record<string, ResultDecl> }) {
  if (!Object.keys(definitions ?? {}).length) return null;
  return <details className="rounded-md border px-3 py-2">
    <summary className="cursor-pointer text-sm font-medium">Results this experiment records</summary>
    <div className="mt-3 max-h-80 overflow-y-auto pr-1">
      <ResultRows definitions={definitions} catalog />
    </div>
  </details>;
}

export function ResultChip({ name, value, unit, definition }: {
  name: string; value: unknown; unit?: string | null; definition?: ResultDecl;
}) {
  const label = definition?.label ?? name;
  const resolvedUnit = unit ?? definition?.unit;
  const title = definition?.description;

  if (typeof value === "boolean")
    return (
      <span className={cn(BASE, NEUTRAL)} title={title}>
        {label}: <b className="font-semibold">{value ? "Yes" : "No"}</b>
      </span>
    );
  if (typeof value === "number")
    return (
      <span className={cn(BASE, NEUTRAL)} title={title}>
        {label} <b className="font-semibold">{fmtNum(value)}</b>
        {resolvedUnit ? <span className="text-muted-foreground">{resolvedUnit}</span> : null}
      </span>
    );
  return <span title={title}><ParamChip name={label} value={value} /></span>;
}

/* summary (run.end / run.json) + metric events, deduped by name (summary wins) */
export function ResultChips({ summary, metrics, definitions }: {
  definitions?: Record<string, ResultDecl>;
  summary?: Record<string, unknown>;
  metrics?: { name: string; value: unknown; unit?: string | null }[];
}) {
  const sum = Object.entries(summary ?? {});
  const seen = new Set(sum.map(([k]) => k));
  const extra = (metrics ?? []).filter((m) => !seen.has(m.name));
  if (!sum.length && !extra.length) return null;
  return (
    <>
      {sum.map(([k, v]) => <ResultChip key={k} name={k} value={v} definition={definitions?.[k]} unit={[...(metrics ?? [])].reverse().find(m => m.name === k)?.unit} />)}
      {extra.map((m) => <ResultChip key={m.name} name={m.name} value={m.value} unit={m.unit} definition={definitions?.[m.name]} />)}
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
   language as AggChips: booleans → neutral Yes counts; numerics → neutral mean
   (a 0/1 numeric is NOT judged pass/fail — refusal=1 is good on agentharm's
   harmful split and bad on the benign one); other values → distinct counts.
   Derived at read time, stored nowhere (docs/book/src/reference/events.md). */
export function InstanceScoreChips({ scores, definitions }: {
  scores: Record<string, unknown>[]; definitions?: Record<string, ResultDecl>;
}) {
  const byKey = new Map<string, unknown[]>();
  for (const s of scores)
    for (const { name, value } of flattenScores(s))
      byKey.set(name, [...(byKey.get(name) ?? []), value]);
  return (
    <>
      {[...byKey.entries()].map(([k, vals]) => {
        const n = vals.length;
        const label = definitions?.[k]?.label ?? k;
        if (vals.every((v) => typeof v === "boolean")) {
          const p = vals.filter(Boolean).length;
          return <span key={k} className={cn(BASE, NEUTRAL)} title={`${p} of ${n} instances reported true`}>{label} {p}/{n} Yes</span>;
        }
        if (vals.every((v) => typeof v === "number")) {
          const mean = (vals as number[]).reduce((a, b) => a + b, 0) / n;
          return (
            <span key={k} className={cn(BASE, NEUTRAL)} title={`mean over ${n} instances`}>
              {label} x̄ <b className="font-semibold">{fmtNum(mean)}</b>
              {definitions?.[k]?.unit && <span>{definitions[k]!.unit}</span>}
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
            {label}{" "}
            {counts.size <= 3
              ? [...counts.entries()].map(([v, c]) => `${v}×${c}`).join(" ")
              : `×${n} values`}
          </span>
        );
      })}
    </>
  );
}

/* aggregate chips over a set of runs (matrix cells): n, per-boolean Yes counts,
   per-numeric means — same chip language as single results */
export function AggChips({ runs }: { runs: RunMeta[] }) {
  const done = runs.filter((r) => r.state === "completed");
  const keys = [...new Set(done.flatMap((r) => Object.keys(r.summary ?? {})))];
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <span className={cn(BASE, NEUTRAL, "text-muted-foreground")}>n={runs.length}</span>
      {keys.map((k) => {
        const vals = done.map((r) => (r.summary ?? {})[k]).filter((v) => v !== undefined);
        if (vals.length && vals.every((v) => typeof v === "boolean")) {
          const p = vals.filter(Boolean).length;
          return <span key={k} className={cn(BASE, NEUTRAL)}>{k} {p}/{vals.length} Yes</span>;
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
