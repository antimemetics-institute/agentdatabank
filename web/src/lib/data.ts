/* Data plumbing shared by the pages: fetch helper, the 2s /api/runs poll hook, the
   param helpers, and the module-level UI state that survives hash navigation
   (filters, agent pick). */

import { useEffect, useState } from "react";
import type { Ev, FullEvent, JobInfo, Manifest, RunMeta, ExecutorInfo } from "@/shared/types";
import { parseEnvelope, parseEventLine } from "./envelope";
import { needsDisplayRecord } from "./event-transport";
import type { JsonSchema } from "./render-hints";
import { object } from "./run-readability";

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
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.error ?? `${r.status} ${path}`);
  }
  return r.json() as Promise<T>;
}

/* POST with the server's {error} body surfaced — the launch/credential endpoints
   answer 4xx with a human sentence (loopback-only, validation, runner refusals)
   that the UI shows verbatim rather than a bare status code */
export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(withBase(path), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data: unknown = await r.json().catch(() => ({}));
  if (!r.ok)
    throw new Error((data as { error?: string }).error ?? `${r.status} ${path}`);
  return data as T;
}

/* experiment manifests (schema for the run-config builder). Per-build-immutable, so
   fetched once per session. null before the first response; [] if the server has no
   manifests dir (bare dev.sh). */
const schemaCache = new Map<string, Promise<JsonSchema[]>>();
export function useRunSchemas(cid: string, rid: string, ready: boolean): JsonSchema[] {
  const [schemas, setSchemas] = useState<JsonSchema[]>([]);
  useEffect(() => {
    if (!ready) return;
    let stopped = false;
    const key = `${cid}/${rid}`;
    if (!schemaCache.has(key)) schemaCache.set(key,
      api<JsonSchema[]>(`/api/runs/${cid}/${rid}/schemas`).catch(() => {
        schemaCache.delete(key);
        return [];
      }));
    void schemaCache.get(key)!.then((value) => { if (!stopped) setSchemas(value); });
    return () => { stopped = true; };
  }, [cid, rid, ready]);
  return schemas;
}

let manifestsCache: Manifest[] | null = null;
export function useManifests(): Manifest[] | null {
  const [ms, setMs] = useState<Manifest[] | null>(manifestsCache);
  useEffect(() => {
    if (manifestsCache) { setMs(manifestsCache); return; }
    let stopped = false;
    void api<Manifest[]>("/api/experiments")
      .then((m) => { manifestsCache = Array.isArray(m) ? m : []; if (!stopped) setMs(manifestsCache); })
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
      if (!Array.isArray(fresh)) return;
      notePollOk();
      runsCache = fresh;
      if (!stopped) setRuns(fresh);
    };
    void load();
    const t = setInterval(() => void load(), 2000);
    return () => { stopped = true; clearInterval(t); };
  }, []);
  return runs;
}

/* ------------- jobs + workers (the launch queue) ------------- */

/* mirror of the server's terminal set (server/queue.ts) — a job in one of these
   states will never change again */
export const JOB_TERMINAL = new Set<JobInfo["state"]>(
  ["completed", "failed", "stopped", "orphaned", "error"]);

/* both polls share the creds surface's tri-state: undefined = first fetch still
   out, null = surface gated for this caller (403/404 — non-loopback without the
   bearer token, or an older server), array = data. Transient errors keep the
   last-known list rather than flapping to "unavailable". */
function useGatedPoll<T>(path: string): T | null | undefined {
  const [data, setData] = useState<T | null | undefined>(undefined);
  useEffect(() => {
    let stopped = false;
    const load = () =>
      api<T>(path)
        .then((d) => { notePollOk(); if (!stopped) setData(d); })
        .catch((e: Error) => {
          if (!stopped && /^40[34] /.test(e.message)) setData(null);
        });
    void load();
    const t = setInterval(() => void load(), 2000);
    return () => { stopped = true; clearInterval(t); };
  }, [path]);
  return data;
}

export const useJobsPoll = (): JobInfo[] | null | undefined =>
  useGatedPoll<JobInfo[]>("/api/jobs");
export const useExecutorPoll = (): ExecutorInfo | null | undefined =>
  useGatedPoll<ExecutorInfo>("/api/executor");
export const useDataDir = (): string | undefined =>
  useGatedPoll<{ home: string }>("/api/ping")?.home;

export const fmtAgo = (iso: string): string => {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return s < 60 ? `${s}s ago`
    : s < 3600 ? `${Math.floor(s / 60)}m ago`
    : `${Math.floor(s / 3600)}h ago`;
};

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

/* stale-running detection (events spec, Ordering & integrity): the runner refreshes
   the card every 10s while alive; its mtime is the server-provided heartbeat.
   A `running` run whose heartbeat is older than 45s
   is displayed as `interrupted?` — never silently `running` forever. Terminal
   states stay terminal. */
const HEARTBEAT_STALE_MS = 45_000;
export function displayState(r: RunMeta, now = Date.now()): string {
  if (r.readable === false) return "unreadable";
  if (r.state === "running" && r.heartbeat_at
      && now - Date.parse(r.heartbeat_at) > HEARTBEAT_STALE_MS)
    return "interrupted?";
  return r.state ?? "unreadable";
}

export async function fetchRunJson(cid: string, rid: string): Promise<string> {
  const response = await fetch(withBase(`/api/runs/${encodeURIComponent(cid)}/${encodeURIComponent(rid)}/run.json`));
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? `run.json unavailable (${response.status})`);
  }
  return response.text();
}

/* run-reference lookup (lineage navigation): resolve a bare run id to its run */
export const findRun = (rid: string): RunMeta | undefined =>
  runsCache?.find((r) => r.run === rid);

/* per-run event cache: revisiting a run (or navigating after a prefetch) renders
   the stream immediately; the run page's incremental poll keeps it current */
export const runCache: Record<string, { events: Ev[]; lastSeq: number }> = {};

export async function loadRunEvents(cid: string, rid: string, after: number): Promise<Ev[]> {
  const values = await api<unknown[]>(`/api/runs/${cid}/${rid}/events?after=${after}`);
  if (!Array.isArray(values)) throw new Error("Unreadable event list");
  return Promise.all(values.map(async (value) => {
    const record = parseEnvelope(value);
    return needsDisplayRecord(record) ? (await fetchFullEvent(cid, rid, record.seq)).record : record;
  }));
}

export async function prefetchRun(cid: string, rid: string): Promise<void> {
  const key = `${cid}/${rid}`;
  if (runCache[key]) return;
  try {
    const events = await loadRunEvents(cid, rid, -1);
    runCache[key] = { events, lastSeq: events[events.length - 1]?.seq ?? -1 };
  } catch { /* run page will fetch on mount */ }
}

/* ------------- wire-diet fetch-on-demand caches (round 7) ------------- */

/* Parsed records and their exact disk lines share a request, never a flattened object. */
const fullEventCache = new Map<string, Promise<FullEvent>>();
export function fetchFullEvent(cid: string, rid: string, seq: number): Promise<FullEvent> {
  const key = `${cid}/${rid}/${seq}`;
  let request = fullEventCache.get(key);
  if (!request) {
    request = (async () => {
      const response = await fetch(withBase(`/api/runs/${cid}/${rid}/event/${seq}`));
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error ?? `Could not read event ${seq}: ${response.status}`);
      }
      const line = await response.text();
      return { record: parseEventLine(line), line };
    })().catch((error) => { fullEventCache.delete(key); throw error; });
    fullEventCache.set(key, request);
  }
  return request;
}

/* full param values behind {__param_ref} descriptors (immutable — cache forever) */
const paramValueCache = new Map<string, unknown>();
export async function fetchParamValue(ref: string): Promise<unknown> {
  if (paramValueCache.has(ref)) return paramValueCache.get(ref);
  const { value } = await api<{ value: unknown }>(`/api/runs/${ref}`);
  paramValueCache.set(ref, value);
  return value;
}

export const paramsOf = (r: RunMeta): Record<string, unknown> | undefined => {
  const value = r.params;
  return object(value) ? value : undefined;
};

export const fmtVal = (v: unknown): string =>
  v === undefined ? "∅" : typeof v === "object" ? JSON.stringify(v) : String(v);

export function groupBy<T>(xs: T[], key: (x: T) => string): Record<string, T[]> {
  const out: Record<string, T[]> = Object.create(null);
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
