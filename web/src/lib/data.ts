/* Data plumbing shared by the pages: fetch helper, the 2s /api/runs poll hook, the
   session-lifetime condition cache (conditions are immutable — fetch each once),
   param helpers, and the module-level UI state that survives hash navigation
   (filters, agent pick). */

import { useEffect, useState } from "react";
import type { Condition, Ev, Manifest, RunMeta } from "@/shared/types";

/* Resolve "/api/..." against the directory the app is served from, not the origin
   root: behind a path-stripping proxy (code-server's /proxy/8340/) the browser must
   request /proxy/8340/api/..., while a direct visit stays /api/... . Hash routing
   keeps location.pathname stable, so this is computed once per request safely. */
function withBase(path: string): string {
  const p = window.location.pathname;
  return (p.endsWith("/") ? p : p + "/") + path.replace(/^\//, "");
}

export async function api<T>(path: string): Promise<T> {
  const r = await fetch(withBase(path));
  if (!r.ok) throw new Error(`${r.status} ${path}`);
  return r.json() as Promise<T>;
}

/* experiment manifests (schema for the run-config builder). Per-build-immutable, so
   fetched once per session. null before the first response; [] if the server has no
   manifests dir (bare dev.sh). */
let manifestsCache: Manifest[] | null = null;
export function useManifests(): Manifest[] | null {
  const [ms, setMs] = useState<Manifest[] | null>(manifestsCache);
  useEffect(() => {
    if (manifestsCache) { setMs(manifestsCache); return; }
    let stopped = false;
    void api<Manifest[]>("/api/experiments")
      .then((m) => { manifestsCache = m; if (!stopped) setMs(m); })
      .catch(() => { if (!stopped) setMs([]); });
    return () => { stopped = true; };
  }, []);
  return ms;
}

/* last-known run list, kept across navigation so a page mount renders instantly
   with current data and refreshes in the background — no "loading…" flash */
let runsCache: RunMeta[] | null = null;

/* the list pages' liveness loop: poll /api/runs every 2s, hydrating the condition
   cache along the way. null only before the first-ever response of the session. */
export function useRunsPoll(): RunMeta[] | null {
  const [runs, setRuns] = useState<RunMeta[] | null>(runsCache);
  useEffect(() => {
    let stopped = false;
    const load = async () => {
      let fresh: RunMeta[];
      try { fresh = await api<RunMeta[]>("/api/runs"); } catch { return; }
      notePollOk();
      await fetchConds(fresh);
      runsCache = fresh;
      if (!stopped) setRuns(fresh);
    };
    void load();
    const t = setInterval(() => void load(), 2000);
    return () => { stopped = true; clearInterval(t); };
  }, []);
  return runs;
}

/* ------------- poll health (the sidebar's connected dot) ------------- */

/* pure frontend state over the existing 2s polls: every successful fetch bumps
   lastPollOk; the dot blinks green per success and goes amber when nothing has
   succeeded for >6s (server down, laptop asleep, …) */
let lastPollOk = 0;
export const notePollOk = (): void => { lastPollOk = Date.now(); };

export function usePollHealth(): { live: boolean; lastOkAt: number } {
  const [state, setState] = useState({ live: false, lastOkAt: 0 });
  useEffect(() => {
    const update = () =>
      setState({ live: Date.now() - lastPollOk < 6000, lastOkAt: lastPollOk });
    update();
    const t = setInterval(update, 1000);
    return () => clearInterval(t);
  }, []);
  return state;
}

/* stale-running detection (events spec, Ordering & integrity): the runner touches
   run.json every 10s while alive; a `running` run whose heartbeat is older than 45s
   is displayed as `interrupted?` — never silently `running` forever. Terminal
   phases are untouched (pre-heartbeat stores freeze mtime at the final write). */
const HEARTBEAT_STALE_MS = 45_000;
export function displayPhase(r: RunMeta): string {
  if (r.phase === "running" && r.heartbeat_at
      && Date.now() - Date.parse(r.heartbeat_at) > HEARTBEAT_STALE_MS)
    return "interrupted?";
  return r.phase;
}

/* run-reference lookup (lineage navigation): resolve a bare run id to its run */
export const findRun = (rid: string): RunMeta | undefined =>
  runsCache?.find((r) => r.run === rid);

/* per-run event cache: revisiting a run (or navigating after a prefetch) renders
   the stream immediately; the run page's incremental poll keeps it current */
export const runCache: Record<string, { events: Ev[]; lastSeq: number }> = {};

/* The wire format is envelope + payload: {v, ts, run, seq, event: {...}} (specs/
   events.md). The GUI's internal view model stays flat — payload fields with the
   envelope's seq/run/v spread over them (envelope wins; a payload's own ts is
   preferred for display, it's the experiment's internal timestamp). Flattening
   happens ONLY here, at the ingress. */
export function flattenEv(raw: Ev): Ev {
  if (raw == null || typeof raw !== "object" || !("event" in raw)) return raw;
  const { event, ...envelope } = raw;
  return { ...(event as Ev), ...envelope, ts: (event as Ev)?.ts ?? raw.ts };
}

export async function prefetchRun(cid: string, rid: string): Promise<void> {
  const key = `${cid}/${rid}`;
  if (runCache[key]) return;
  try {
    const events = (await api<Ev[]>(`/api/runs/${cid}/${rid}/events?after=-1`)).map(flattenEv);
    runCache[key] = { events, lastSeq: events[events.length - 1]?.seq ?? -1 };
  } catch { /* run page will fetch on mount */ }
}

/* ------------- wire-diet fetch-on-demand caches (round 7) ------------- */

/* full single events, fetched when the UI expands into an __elided marker */
const fullEventCache = new Map<string, Ev>();
export async function fetchFullEvent(cid: string, rid: string, seq: unknown): Promise<Ev | null> {
  const k = `${cid}/${rid}/${String(seq)}`;
  const hit = fullEventCache.get(k);
  if (hit) return hit;
  try {
    const ev = flattenEv(await api<Ev>(`/api/runs/${cid}/${rid}/event/${String(seq)}`));
    fullEventCache.set(k, ev);
    return ev;
  } catch { return null; }
}

/* full param values behind {__param_ref} descriptors (immutable — cache forever) */
const paramValueCache = new Map<string, unknown>();
export async function fetchParamValue(ref: string): Promise<unknown> {
  if (paramValueCache.has(ref)) return paramValueCache.get(ref);
  const { value } = await api<{ value: unknown }>(`/api/params/${ref}`);
  paramValueCache.set(ref, value);
  return value;
}

/* ------------- conditions cache ------------- */

export const conds: Record<string, Condition> = {};

export async function fetchConds(runs: RunMeta[]): Promise<void> {
  const missing = [...new Set(runs.map((r) => r.condition))].filter((c) => c && !(c in conds));
  await Promise.all(missing.map(async (c) => {
    try { conds[c] = await api<Condition>(`/api/conditions/${c}`); }
    catch { /* not written yet or unreadable — retried next poll */ }
  }));
}

/* condition params, with run.json's realized_params as a fallback so a run is
   renderable even before its condition file lands */
export const paramsOf = (r: RunMeta): Record<string, unknown> | undefined =>
  conds[r.condition]?.params ?? (r.realized_params as Record<string, unknown> | undefined);

export const fmtVal = (v: unknown): string =>
  v === undefined ? "∅" : typeof v === "object" ? JSON.stringify(v) : String(v);

export function groupBy<T>(xs: T[], key: (x: T) => string): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const x of xs) (out[key(x)] ??= []).push(x);
  return out;
}

/* param keys taking >1 distinct value across these runs, most-varied first */
export function variedKeys(runs: RunMeta[]): string[] {
  const ps = runs.map(paramsOf).filter((p): p is Record<string, unknown> => !!p);
  const keys = [...new Set(ps.flatMap((p) => Object.keys(p)))];
  return keys
    .map((k) => [k, new Set(ps.map((p) => fmtVal(p[k]))).size] as const)
    .filter(([, n]) => n > 1)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k]) => k);
}

export function constantParams(runs: RunMeta[], varied: string[]): [string, string][] {
  const p = runs.map(paramsOf).find(Boolean);
  return p
    ? Object.entries(p).filter(([k]) => !varied.includes(k)).map(([k, v]) => [k, fmtVal(v)])
    : [];
}

/* ------------- filters (multi-select within a param = OR, across params = AND) ------------- */

export type Filters = Record<string, Record<string, string[]>>;

export function toggleFilter(filters: Filters, exp: string, key: string, val: string): Filters {
  const next: Filters = { ...filters, [exp]: { ...(filters[exp] ?? {}) } };
  const sel = [...(next[exp]![key] ?? [])];
  const i = sel.indexOf(val);
  if (i >= 0) sel.splice(i, 1); else sel.push(val);
  if (sel.length) next[exp]![key] = sel; else delete next[exp]![key];
  return next;
}

export function passesFilters(filters: Filters, r: RunMeta): boolean {
  const byKey = filters[r.experiment];
  if (!byKey) return true;
  const p = paramsOf(r) ?? {};
  return Object.entries(byKey).every(([k, sel]) => sel.includes(fmtVal(p[k])));
}

/* ------------- UI state that outlives navigation (was global in the vanilla app) ------------- */

export const uiState: {
  filters: Filters;
  agent: string | null;
  /* event-stream gutter: absolute wall-clock vs relative offset (user toggle) */
  gutterMode?: "absolute" | "relative";
} = {
  filters: {},
  agent: null,
};
