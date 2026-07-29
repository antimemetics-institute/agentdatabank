/* Run page — consumes ONLY the event stream (incremental /events?after=N polls, 2s),
   rendered as ONE view: the flat event feed (components/event-stream.tsx,
   independently scrollable with auto-follow). Filter chips narrow it to a single
   event family (messages / llm calls / metrics / …) — filters over the ground
   truth, not separate projections. */

import { useEffect, useReducer, useRef, useState } from "react";
import type { Ev } from "@/shared/types";
import { api, conds, displayPhase, flattenEv, fmtVal, runCache, uiState, useRunsPoll } from "@/lib/data";
import type { RunMeta } from "@/shared/types";
import { Chip, ExitBadge, LiveDot, LoadingBar, PhaseBadge, Skeleton } from "@/components/bits";
import { InstanceScoreChips, ResultChip, ResultChips, dedupeMetrics } from "@/components/results";
import { EventStream } from "@/components/event-stream";
import { ParamChip } from "@/components/param-value";
import { cn } from "@/lib/utils";

/* the filterable event families; a chip only appears when the run has any */
const FILTERS: { key: string; label: string; pred: (e: Ev) => boolean }[] = [
  { key: "messages", label: "messages", pred: (e) => e.type === "message" },
  { key: "llm-calls", label: "llm calls", pred: (e) => e.type === "llm.call" },
  { key: "metrics", label: "metrics", pred: (e) => e.type === "metric" },
  /* instance close-outs only — the per-row results overview for dataset-style
     runs (kind=sample is the legacy pre-spec name) */
  { key: "instances", label: "instances",
    pred: (e) => e.type === "agent.event" && (e.kind === "instance" || e.kind === "sample") },
  { key: "agent-events", label: "agent events", pred: (e) => e.type === "agent.event" },
  { key: "logs", label: "logs", pred: (e) => e.type === "log" || e.type === "stdout" || e.type === "stderr" },
];

export function RunPage({ cid, rid }: { cid: string; rid: string }) {
  /* seeded from the session cache (a prefetch or a previous visit) so mounting never
     flashes an empty page; the component is keyed by cid/rid, so refs re-init per run */
  const key = `${cid}/${rid}`;
  const eventsRef = useRef<Ev[]>(runCache[key]?.events ?? []);
  const lastSeqRef = useRef(runCache[key]?.lastSeq ?? -1);
  const [, bump] = useReducer((x: number) => x + 1, 0);
  const [filter, setFilter] = useState<string>("all");
  /* run.json meta rides the same 2s poll — carries the runner's heartbeat
     (heartbeat_at), which decides running vs interrupted? in the header */
  const meta = useRunsPoll()?.find((r) => r.condition === cid && r.run === rid) ?? null;

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const done = () => eventsRef.current.some((ev) => ev.type === "run.end");
    const poll = async () => {
      let fresh: Ev[];
      try {
        fresh = (await api<Ev[]>(`/api/runs/${cid}/${rid}/events?after=${lastSeqRef.current}`)).map(flattenEv);
      } catch { return; }
      if (stopped) return;
      if (fresh.length) {
        eventsRef.current = [...eventsRef.current, ...fresh];
        lastSeqRef.current = fresh[fresh.length - 1]!.seq ?? lastSeqRef.current;
        runCache[`${cid}/${rid}`] = { events: eventsRef.current, lastSeq: lastSeqRef.current };
        bump();
      }
      /* terminal streams are immutable — only live runs keep polling */
      if (done() && timer !== null) { clearInterval(timer); timer = null; }
    };
    void poll().then(() => {
      if (!stopped && !done()) timer = setInterval(() => void poll(), 2000);
    });
    return () => { stopped = true; if (timer !== null) clearInterval(timer); };
  }, [cid, rid]);

  useEffect(() => {
    if (cid in conds) return;
    api(`/api/conditions/${cid}`)
      .then((c) => { conds[cid] = c as never; bump(); })
      .catch(() => { /* not written yet */ });
  }, [cid]);

  const events = eventsRef.current;

  /* chips only for families this run actually has; a stale pick falls back to all */
  const filters = FILTERS.filter((f) => events.some(f.pred));
  const activeFilter = filters.find((f) => f.key === filter);
  const visible = activeFilter ? events.filter(activeFilter.pred) : events;

  const end = events.find((e) => e.type === "run.end");
  /* one display phase for the whole page: run.end wins; otherwise run.json's
     heartbeat decides running vs interrupted?; event-derived fallback */
  const phase = end ? end.phase
    : meta ? displayPhase(meta)
    : events.some((e) => e.type === "run.status") ? "running" : "provisioning";
  if (!events.length)
    return (
      <div className="space-y-3 pt-1">
        <LoadingBar />
        <Skeleton className="h-16" />
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-64" />
      </div>
    );
  return (
    <div className="flex h-full flex-col gap-3">
      <RunHead cid={cid} rid={rid} events={events} phase={phase} />
      {filters.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-muted-foreground">filter:</span>
          {[{ key: "all", label: "all" }, ...filters].map((f) => (
            <button key={f.key} type="button" data-filter={f.key}
              onClick={() => setFilter(f.key)}
              className={cn(
                "rounded-full border px-2.5 py-0.5",
                (activeFilter ? filter : "all") === f.key
                  ? "border-primary bg-primary/10 text-foreground"
                  : "border-transparent text-muted-foreground hover:border-ring hover:text-foreground",
              )}>
              {f.label}
            </button>
          ))}
        </div>
      )}
      <div className="min-h-0 flex-1">
        <EventStream events={visible} phase={phase} mode="flat" cid={cid} rid={rid} />
      </div>
    </div>
  );
}

/* ---------------- header ---------------- */

function RunHead({ cid, rid, events, phase }: {
  cid: string; rid: string; events: Ev[]; phase: string;
}) {
  const [details, setDetails] = useState(false);
  const start = events.find((e) => e.type === "run.start") ?? {};
  const end = events.find((e) => e.type === "run.end");
  const lastStatus = [...events].reverse().find((e) => e.type === "status");
  const summary: Record<string, unknown> = end ? end.summary ?? {} : {};
  /* metric events collapse last-value-wins per name (docs/plan/events.md);
     summary keys win over same-named metrics as before */
  const metrics = dedupeMetrics(events
    .filter((e) => e.type === "metric")
    .map((e) => ({ name: String(e.name), value: e.value as unknown, unit: e.unit as string | null })));
  const extras = metrics.filter((m) => !(m.name in summary));
  /* per-instance scores → read-time aggregate chips (legacy kind=sample included) */
  const instScores = events
    .filter((e) => e.type === "agent.event" && (e.kind === "instance" || e.kind === "sample")
      && e.data?.scores && Object.keys(e.data.scores).length > 0)
    .map((e) => e.data.scores as Record<string, unknown>);
  const usage = end?.usage_totals;
  const params = (conds[cid]?.params ?? start.realized_params) as Record<string, unknown> | undefined;
  const nParams = params ? Object.keys(params).length : 0;
  return (
    <div className="space-y-2">
      <h2 className="flex items-center gap-3 text-lg font-semibold">
        {start.experiment ?? "run"}
        <PhaseBadge phase={phase} />
      </h2>
      <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 text-sm">
        <span className="font-mono text-xs text-muted-foreground">{cid.slice(0, 12)} · {rid}</span>
        <span>seed <b className="font-semibold">{fmtVal(start.seed)}</b></span>
        <span>replicate <b className="font-semibold">{fmtVal(start.replicate)}</b></span>
        {usage && (
          <span>{fmtVal(usage.llm_calls)} calls · {fmtVal(usage.input_tokens)}+{fmtVal(usage.output_tokens)} tok</span>
        )}
        {!end && lastStatus && <span className="text-muted-foreground">{lastStatus.detail}</span>}
      </div>
      {/* results card: ONE glanceable headline row (run.end summary + derived
          instance aggregates); everything else — every metric, every param — sits
          behind the details toggle in a height-bounded scroller, so no data shape
          can ever push the event stream off-screen */}
      {(Object.keys(summary).length > 0 || instScores.length > 0 || extras.length > 0 || nParams > 0) && (
        <div className="rounded-lg border bg-card px-3 py-2">
          <div className="flex max-h-24 flex-wrap items-center gap-1.5 overflow-y-auto">
            <span className="mr-1 text-[10px] uppercase tracking-wider text-muted-foreground">results</span>
            <ResultChips summary={summary} />
            <InstanceScoreChips scores={instScores} />
            {(extras.length > 0 || nParams > 0) && (
              <button
                type="button"
                onClick={() => setDetails(!details)}
                className="rounded-full border px-2 font-mono text-[11px] leading-5 text-muted-foreground hover:bg-accent"
              >
                {details ? "hide details" : [
                  extras.length > 0 ? `${extras.length} metrics` : null,
                  nParams > 0 ? `${nParams} params` : null,
                ].filter(Boolean).join(" · ")}
              </button>
            )}
          </div>
          {details && (
            <div className="mt-1.5 max-h-48 space-y-1.5 overflow-y-auto border-t pt-1.5">
              {extras.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="mr-1 text-[10px] uppercase tracking-wider text-muted-foreground">metrics</span>
                  {extras.map((m) => (
                    <span key={m.name} className="inline-flex items-center gap-1">
                      <ResultChip name={m.name} value={m.value} unit={m.unit} />
                      {m.count > 1 && (
                        <span className="font-mono text-[10px] text-muted-foreground" title="same-named metric re-emitted; last value shown">
                          ×{m.count}
                        </span>
                      )}
                    </span>
                  ))}
                </div>
              )}
              {nParams > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="mr-1 text-[10px] uppercase tracking-wider text-muted-foreground">params</span>
                  {Object.entries(params!).map(([k, v]) => (
                    <ParamChip key={k} name={k} value={v} />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

