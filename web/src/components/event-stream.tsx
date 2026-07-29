/* The colorful event stream — two modes over one pane:

   mode="flat" (the "events" tab, first and DEFAULT — the ground-truth view): every
   event is its own row, one by one, strictly in seq order, no grouping. Row headers
   are MINIMAL: per-agent constants (model, provider, via) live once in the agents
   legend; a row carries only what varies — time, agent (multi-agent runs), the
   content preview, error/empty/verdict flags. Per-call facts (model/tokens/latency)
   are the first line of the llm.call expansion; the event type + seq + ids live in
   the row tooltip and raw JSON. Tool rows read as actions: colored icon + tool +
   primary arg, then the result preview.

   mode="turns" (the "turns" tab): the grouped TURN-CARD projection — one card per
   llm.call absorbing the same-agent tool_call/tool_result agent.events that follow
   it (matched by agent + order/id, up to the next llm.call). Grouping (groupEvents,
   pure) is presentation only and recomputed per render, so tool events arriving in
   later polls join their card without disturbing incremental append.

   Both modes share the pane: independent scrolling, auto-follow with pause-on-
   scroll-up, and the LiveDot in the header vouching for exactly this stream. */

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Activity, ArrowDown, Brain, CircleCheck, CircleHelp, CircleX, FileJson, FileText,
  Flag, Gauge, Image, Info, Maximize2, MessageSquare, Minimize2, Package, Play,
  Sparkles, Terminal, Wrench,
} from "lucide-react";
import type { Ev } from "@/shared/types";
import { fetchFullEvent, fmtVal, uiState } from "@/lib/data";
import { highlightJson } from "@/lib/markdown";
import { ExitBadge, InheritedBadge, LiveDot, MdView, PhaseBadge, Segmented } from "@/components/bits";
import { ResultChip, flattenScores } from "@/components/results";
import { cn } from "@/lib/utils";
import { containsElision, elStr, isElided } from "@/lib/content";

/* ---------------- per-type styling ---------------- */

type Style = { Icon: typeof Info; badge: string; icon: string };

/* tailwind can't see computed class names — every hue is written out literally */
const STYLES: Record<string, Style> = {
  "run.start": { Icon: Play, badge: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400", icon: "text-emerald-600 dark:text-emerald-400" },
  "run.status": { Icon: Activity, badge: "border border-border/60 text-muted-foreground/80", icon: "text-muted-foreground" },
  "run.end": { Icon: Flag, badge: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400", icon: "text-emerald-600 dark:text-emerald-400" },
  status: { Icon: Info, badge: "border border-border/60 text-muted-foreground/80", icon: "text-muted-foreground" },
  log: { Icon: FileText, badge: "bg-slate-500/15 text-slate-700 dark:text-slate-400", icon: "text-slate-600 dark:text-slate-400" },
  stdout: { Icon: FileText, badge: "border border-border/60 text-muted-foreground/80", icon: "text-muted-foreground" },
  stderr: { Icon: FileText, badge: "border border-red-500/40 text-red-700 dark:text-red-400", icon: "text-red-600 dark:text-red-400" },
  message: { Icon: MessageSquare, badge: "bg-sky-500/15 text-sky-700 dark:text-sky-400", icon: "text-sky-600 dark:text-sky-400" },
  "llm.call": { Icon: Sparkles, badge: "bg-violet-500/15 text-violet-700 dark:text-violet-400", icon: "text-violet-600 dark:text-violet-400" },
  "agent.event": { Icon: Terminal, badge: "bg-amber-500/15 text-amber-700 dark:text-amber-400", icon: "text-amber-600 dark:text-amber-400" },
  metric: { Icon: Gauge, badge: "bg-teal-500/15 text-teal-700 dark:text-teal-400", icon: "text-teal-600 dark:text-teal-400" },
  artifact: { Icon: Package, badge: "bg-cyan-500/15 text-cyan-700 dark:text-cyan-400", icon: "text-cyan-600 dark:text-cyan-400" },
};
const FALLBACK: Style = { Icon: CircleHelp, badge: "bg-muted text-muted-foreground", icon: "text-muted-foreground" };

const RED = "bg-red-500/15 text-red-700 dark:text-red-400";
const RED_ICON = "text-red-600 dark:text-red-400";
const AMBER = "bg-amber-500/15 text-amber-700 dark:text-amber-400";
const EMPTY_FLAG =
  "rounded border border-dashed border-amber-500/60 px-1 font-mono text-[10px] text-amber-700 dark:text-amber-400";

/* channel → stable color (messages) */
const CHANNEL_HUES = [
  "text-sky-700 dark:text-sky-400",
  "text-violet-700 dark:text-violet-400",
  "text-emerald-700 dark:text-emerald-400",
  "text-amber-700 dark:text-amber-400",
  "text-rose-700 dark:text-rose-400",
  "text-cyan-700 dark:text-cyan-400",
];
const channelHue = (ch: unknown): string => {
  const s = String(ch ?? "");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return CHANNEL_HUES[h % CHANNEL_HUES.length]!;
};

/* tool rows/chips take their visual identity from the TOOL, not the event type:
   fixed hues for the common tools, stable hash-color fallback for the rest */
const TOOL_COLORS: [RegExp, string][] = [
  [/^(read|view|cat|open|ls|list|glob|grep|search)/i, "text-blue-700 dark:text-blue-400"],
  [/^(write|edit|patch|apply|create)/i, "text-orange-700 dark:text-orange-400"],
  [/(bash|exec|shell|run|cmd|terminal)/i, "text-emerald-700 dark:text-emerald-400"],
  [/(pytest|test|check|lint|grade)/i, "text-violet-700 dark:text-violet-400"],
];
function toolHue(name: string): string {
  for (const [re, cls] of TOOL_COLORS) if (re.test(name)) return cls;
  return channelHue(name);
}

/* smooth-scroll to an event row and flash it (reuses the nav-glow pulse) */
function flashRow(seq: unknown): void {
  const el = document.getElementById(`ev-${String(seq)}`);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.add("nav-glow");
  setTimeout(() => el.classList.remove("nav-glow"), 1600);
}

/* ---------- gutter: time, not seq ----------
   Inter-event spacing is what a reader wants; the seq (ordering key, future
   click-to-branch anchor) and the other time form live in the tooltip.
   Modes: absolute wall-clock (default, user toggle in the pane header) or
   relative offset from run start. Dimming is gentle: the first row of each
   second shows the time, the second shows it dimmed, only 3+ in the same
   second become dots — and every row's tooltip always carries the real time.
   ts may be an ISO string or epoch millis (pi transcript entries); an event
   with no parseable ts inherits the previous event's time (runner envelopes
   always have one, so this is belt-and-suspenders) — no row renders timeless. */
export type GutterMode = "absolute" | "relative";
export type GutterInfo = { label: string; dim: boolean; dot: boolean; title: string };

const fmtOffset = (sec: number): string => {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const ss = sec % 60;
  return h
    ? `+${h}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`
    : `+${m}:${String(ss).padStart(2, "0")}`;
};

/* ISO strings and epoch numbers (seconds or millis) both resolve */
function parseTsMs(e: Ev): number | null {
  const v = e.ts;
  if (typeof v === "number" && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
  if (typeof v === "string") {
    const t = v.trim();
    if (/^\d+$/.test(t)) { const n = +t; return n < 1e12 ? n * 1000 : n; }
    const p = Date.parse(t);
    if (Number.isFinite(p)) return p;
  }
  return null;
}

export function buildGutters(events: Ev[], mode: GutterMode): Map<unknown, GutterInfo> {
  const map = new Map<unknown, GutterInfo>();
  let t0: number | null = null;
  let prevMs: number | null = null;
  let curSec: number | null = null;
  let nInSec = 0;
  for (const e of events) {
    let ms = parseTsMs(e);
    let inherited = false;
    if (ms === null && prevMs !== null) { ms = prevMs; inherited = true; }
    if (ms !== null && t0 === null) t0 = ms;
    if (ms !== null) prevMs = ms;
    let label = `#${fmtVal(e.seq)}`;
    let rel = "";
    let abs = "";
    let sec: number | null = null;
    if (ms !== null && t0 !== null) {
      sec = Math.floor(ms / 1000);
      rel = fmtOffset(Math.max(0, Math.round((ms - t0) / 1000)));
      const dd = new Date(ms);
      abs = [dd.getHours(), dd.getMinutes(), dd.getSeconds()]
        .map((n) => String(n).padStart(2, "0")).join(":");
      label = mode === "absolute" ? abs : rel;
    }
    if (sec !== null && sec === curSec) nInSec += 1;
    else { curSec = sec; nInSec = 1; }
    map.set(e.seq, {
      label,
      dim: sec !== null && nInSec === 2,
      dot: sec !== null && nInSec >= 3,
      title: `seq ${fmtVal(e.seq)} · ${mode === "absolute" ? rel : abs}`
        + `${e.ts !== undefined ? ` · ${String(e.ts)}` : ""}`
        + `${inherited ? " · ts inherited from previous event" : ""}`,
    });
  }
  return map;
}

const Gutter = ({ g }: { g?: GutterInfo }) => (
  <span
    title={g?.title}
    className={cn(
      "w-14 shrink-0 select-none text-right font-mono text-[10px]",
      g?.dim || g?.dot ? "text-muted-foreground/40" : "text-muted-foreground/70",
    )}
  >
    {g ? (g.dot ? "·" : g.label) : ""}
  </span>
);

/* "12:00:02"–"12:00:07" → "12:00:02–07" (trim the shared prefix at a colon) */
const trimCommon = (a: string, b: string): string => {
  let cut = 0;
  for (let i = 0; i < Math.min(a.length, b.length) && a[i] === b[i]; i++)
    if (a[i] === ":") cut = i + 1;
  return b.slice(cut);
};

/* ---------- display profile (the presentation-hint seam, v1 §4) ----------
   Derived from the stream per render: what's CONSTANT across the whole stream is
   noise in row headers (single-agent runs don't need an agent chip; single-channel
   runs don't need "#channel"). A per-experiment hint will later override these
   derivations — same philosophy as pickWidget's hint arg: derive now, hint later. */
/* per-agent facts that are CONSTANT across the stream — they live in the legend,
   shown once, never in row headers */
export interface AgentInfo {
  name: string;
  model?: string;
  /* distinct models the provider REPORTED serving (llm.call response.model) —
     what actually ran, vs `model` = what was requested */
  served?: string[];
  via?: string;
  calls: number;
}

export interface StreamProfile {
  agentCount: number;
  showAgent: boolean;
  channelCount: number;
  showChannel: boolean;
  /* default gutter mode — constant today; the seam a per-experiment manifest
     hint will set later (same precursor pattern as showAgent) */
  gutterMode: GutterMode;
  /* the agents legend: role-ish name, model+provider, telemetry provenance.
     TODO(manifest-hints): a future per-experiment hint could DECLARE agent
     definitions (roles, models, provenance) instead of deriving them here. */
  agents: AgentInfo[];
}
export function deriveProfile(events: Ev[]): StreamProfile {
  const agents = new Map<string, AgentInfo>();
  const channels = new Set<string>();
  for (const e of events) {
    if (typeof e.agent === "string") {
      const a = agents.get(e.agent) ?? { name: e.agent, calls: 0 };
      if (e.type === "llm.call") {
        a.calls += 1;
        if (typeof e.model === "string") a.model = e.model;
        const served = (e.response as { model?: unknown } | undefined)?.model;
        if (typeof served === "string" && !(a.served ?? []).includes(served))
          a.served = [...(a.served ?? []), served];
      }
      if (typeof e.via === "string") a.via = e.via;
      agents.set(e.agent, a);
    }
    if (e.type === "message" && e.channel !== undefined) channels.add(String(e.channel));
  }
  return {
    agentCount: agents.size,
    showAgent: agents.size > 1,
    channelCount: channels.size,
    showChannel: channels.size > 1,
    gutterMode: "absolute",
    agents: [...agents.values()],
  };
}

/* the legend strip — the single home for model names, provider prefixes, and
   via provenance; row headers carry only per-row facts */
function AgentsLegend({ agents }: { agents: AgentInfo[] }) {
  if (!agents.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b bg-muted/20 px-2.5 py-1">
      {agents.map((a) => (
        <span
          key={a.name}
          className="inline-flex items-baseline gap-1.5 rounded-md border bg-background px-2 py-0.5 text-[11px]"
          title={`agent ${a.name}`
            + `${a.model ? ` · requested ${a.model}` : ""}`
            + `${a.served?.length ? ` · provider reported serving ${a.served.join(", ")}` : ""}`
            + `${a.calls ? ` · ${a.calls} llm call(s)` : ""}`
            + `${a.via ? ` · telemetry via ${a.via} — harness-normalized secondary record` : ""}`}
        >
          <span className="font-semibold">{a.name}</span>
          {/* the model the provider REPORTED serving leads; the requested id is
              only shown when it told us something different (alias, deployment) */}
          {a.served?.length ? (
            <span className="font-mono text-foreground">{a.served.join(" · ")}</span>
          ) : a.model ? (
            <span className="font-mono text-muted-foreground">{a.model.split("/").pop()}</span>
          ) : null}
          {a.model && a.served?.length === 1 && a.served[0] !== a.model.split("/").pop() &&
            a.served[0] !== a.model && (
            <span className="text-muted-foreground/60">← {a.model}</span>
          )}
          {(a.served?.length ?? 0) > 1 && (
            <span className="rounded bg-amber-500/15 px-1 text-[10px] text-amber-700 dark:text-amber-400">
              varied
            </span>
          )}
          {a.via && <span className="text-muted-foreground/60">— {a.via}</span>}
        </span>
      ))}
    </div>
  );
}

/* declared verdicts ONLY (docs/plan/events.md, tools convention): exit_code and
   ok are the two fields an emitter declares as its own pass/fail. The old
   string-regex and pytest-tail sniffing is gone — undeclared data renders
   neutral, never judged from shape. null = no declared verdict. */
function verdict(d: Ev | undefined): boolean | null {
  if (!d) return null;
  if (typeof d.exit_code === "number") return d.exit_code === 0;
  if (typeof d.ok === "boolean") return d.ok;
  return null;
}

function VerdictBadge({ v }: { v: boolean | null }) {
  if (v === null) return null;
  return v ? (
    <span className="inline-flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-400">
      <CircleCheck className="size-3.5" /> pass
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-xs text-red-700 dark:text-red-400">
      <CircleX className="size-3.5" /> fail
    </span>
  );
}

const firstLine = (s: unknown): string => String(s ?? "").split("\n")[0] ?? "";

/* ---------- wire-diet elision (round 7) ----------
   The server replaces quadratic fields (request.messages, response.raw) and any
   string > ~4 KB with {__elided: {bytes, preview}} markers. Rows/cards render
   from previews; expanding into a marker fetches the FULL event once (cached). */
const hasElisions = (e: Ev): boolean => JSON.stringify(e).includes('"__elided"');

/* summary-line chip policy: shell-shaped tools always show their exit code;
   path-shaped (read/write/edit…) only flag failure — success needs no chip */
const isShellTool = (name: string): boolean => /(bash|exec|shell|run|cmd|terminal)/i.test(name);
function ToolOutcomeChip({ name, exitCode, v }: {
  name: string; exitCode: unknown; v: boolean | null;
}) {
  const hasExit = typeof exitCode === "number";
  if (hasExit && (isShellTool(name) || exitCode !== 0)) return <ExitBadge code={exitCode} />;
  if (!hasExit && v === false) return <VerdictBadge v={v} />;
  if (!hasExit && v !== null && isShellTool(name)) return <VerdictBadge v={v} />;
  return null;
}

function LoadFullButton({ onLoad, loading }: { onLoad: () => void; loading: boolean }) {
  return (
    <button
      type="button"
      onClick={(ev) => { ev.stopPropagation(); onLoad(); }}
      className="rounded border border-dashed border-amber-500/60 px-1.5 font-mono text-[10px] text-amber-700 hover:bg-amber-500/10 dark:text-amber-400"
      title="large fields were elided on the wire — fetch the full event"
    >
      {loading ? "loading…" : "elided — load full event"}
    </button>
  );
}

/* harness-normalized events carry `via: "<normalizer>"` — a provenance stamp:
   secondary record, reconstructed from the tool's session transcript (experiment-
   primary events have no via). Rendered as a subtle badge. */
/* per-call facts (model, tokens, latency, provenance) — the expansion's first
   line, not the row header */
const FactsLine = ({ e }: { e: Ev }) => {
  const u = e.usage ?? {};
  const served = (e.response as { model?: unknown } | undefined)?.model;
  const model =
    typeof served === "string" && served !== e.model
      ? `${String(e.model ?? "")} → ${served}` /* requested → what the provider reported serving */
      : String(e.model ?? "");
  return (
    <div className="font-mono text-[11px] text-muted-foreground">
      {model} · {fmtVal(u.input_tokens)}+{fmtVal(u.output_tokens)} tok · {fmtVal(e.latency_ms)}ms
      {e.via ? ` · via ${String(e.via)}` : ""}
    </div>
  );
};

/* request-section label: new linear streams carry request.derived_from_stream
   (messages: [] — reproducible from the pinned rev + prior events); old pi
   streams carry actual folded messages (reconstructed); primary events carry the
   real request */
const reqLabel = (e: Ev): { text: string; title?: string } =>
  e.request?.derived_from_stream
    ? { text: "derived from stream", title: "reproducible from the pinned rev + prior events" }
    : e.via
      ? { text: "reconstructed request" }
      : { text: "request" };

const fmtBytes = (n: unknown): string => {
  const b = typeof n === "number" ? n : NaN;
  if (!Number.isFinite(b)) return "";
  if (b >= 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  if (b >= 1024) return `${(b / 1024).toFixed(1)} kB`;
  return `${b} B`;
};

/* highlighted JSON block — same escape-first discipline (highlightJson escapes) */
const JsonPre = ({ src, className }: { src: string; className?: string }) => (
  <pre
    className={cn(
      "max-h-64 overflow-y-auto whitespace-pre-wrap rounded-md border bg-muted/50 px-2.5 py-1.5 font-mono text-xs [overflow-wrap:anywhere]",
      className,
    )}
    dangerouslySetInnerHTML={{ __html: highlightJson(src) }}
  />
);

const Mono = ({ children, className }: { children: string; className?: string }) => (
  <pre className={cn(
    "max-h-64 overflow-y-auto whitespace-pre-wrap rounded-md border bg-muted/50 px-2.5 py-1.5 font-mono text-xs [overflow-wrap:anywhere]",
    className,
  )}>
    {children}
  </pre>
);

/* one click, one blob: the highlighted JSON is directly inside — no inner
   per-event collapse */
const RawDetails = ({ events, onOpen }: { events: Ev[]; onOpen?: () => void }) => (
  <details onToggle={(ev) => { if ((ev.target as HTMLDetailsElement).open) onOpen?.(); }}>
    <summary className="cursor-pointer text-[10px] uppercase tracking-wider text-muted-foreground">
      raw event{events.length > 1 ? `s (${events.length})` : ""}
    </summary>
    <div className="mt-1 space-y-1">
      {events.map((e) => (
        <JsonPre key={e.seq} src={JSON.stringify(e, null, 2)} />
      ))}
    </div>
  </details>
);

const toolsSummary = (chips: { name: string; primary: string }[]): string =>
  chips.map((c) => `${c.name} ${c.primary}`.trim()).join(", ");

/* reasoning is CONTENT, not an attachment: a visible styled block, clamped to ~4
   lines; only the FULL text hides behind the "show all" expander */
function ReasoningBlock({ text }: { text: string }) {
  const [full, setFull] = useState(false);
  const long = text.length > 300 || text.split("\n").length > 4;
  return (
    <div
      className="rounded-md border border-border/60 bg-muted/30 px-2.5 py-1.5"
      title="the model's reasoning_content — not the assistant message"
    >
      <div className="mb-0.5 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
        <Brain className="size-3" /> reasoning (provider thinking)
      </div>
      <div className={cn(
        "whitespace-pre-wrap text-xs italic text-muted-foreground",
        !full && long && "line-clamp-4",
      )}>
        {text}
      </div>
      {long && (
        <button
          type="button"
          onClick={() => setFull((f) => !f)}
          className="mt-0.5 text-[10px] text-primary hover:underline"
        >
          {full ? "clamp" : `show all · ${text.length} chars`}
        </button>
      )}
    </div>
  );
}

/* tool output, visible-by-default: first lines shown, full scrollable block
   behind the expander */
function ClampedMono({ text, clamp = 4 }: { text: string; clamp?: number }) {
  const [full, setFull] = useState(false);
  const long = text.split("\n").length > clamp || text.length > 400;
  if (!long || full)
    return (
      <div>
        <Mono>{text}</Mono>
        {long && (
          <button type="button" onClick={() => setFull(false)}
            className="mt-0.5 text-[10px] text-primary hover:underline">
            clamp
          </button>
        )}
      </div>
    );
  return (
    <div>
      <pre className="line-clamp-4 whitespace-pre-wrap rounded-md border bg-muted/50 px-2.5 py-1.5 font-mono text-xs [overflow-wrap:anywhere]">
        {text}
      </pre>
      <button type="button" onClick={() => setFull(true)}
        className="mt-0.5 text-[10px] text-primary hover:underline">
        show all · {text.split("\n").length} lines
      </button>
    </div>
  );
}

/* ---------------- turn grouping (presentation only) ---------------- */

type StreamItem =
  | { kind: "row"; e: Ev }
  | { kind: "turn"; call: Ev; tools: Ev[] };

/* tool_result seq → the paired request (name + primary arg), resolved from the
   preceding same-agent llm.call's tool_calls via tool_call_id (single-request
   fallback when id-less). The result event alone only has output. */
function buildLinkIndexes(events: Ev[]): {
  reqIndex: Map<unknown, { name: string; primary: string }>;
  resSeq: Map<string, unknown>;
} {
  const reqIndex = new Map<unknown, { name: string; primary: string }>();
  /* `${callSeq}:${tcId | i<ordinal>}` → the matching tool_result's seq */
  const resSeq = new Map<string, unknown>();
  const lastCall: Record<string, Ev> = {};
  const ordinal: Record<string, number> = {};
  for (const e of events) {
    if (e.type === "llm.call") { lastCall[e.agent] = e; ordinal[e.agent] = 0; continue; }
    if (e.type !== "agent.event" || e.kind !== "tool_result") continue;
    const call = lastCall[e.agent];
    const tcs: Ev[] = call?.response?.message?.tool_calls ?? [];
    const id = e.data?.tool_call_id ?? e.data?.id;
    let tc = id !== undefined ? tcs.find((t) => (t.id ?? t.tool_call_id) === id) : undefined;
    let keyPart = tc ? String(id) : undefined;
    if (!tc) {
      const i = ordinal[e.agent] ?? 0;
      if (id === undefined) { tc = tcs[i]; keyPart = `i${i}`; }
      ordinal[e.agent] = i + 1;
    }
    if (call && keyPart !== undefined) resSeq.set(`${call.seq}:${keyPart}`, e.seq);
    if (tc) {
      const name = toolName(tc);
      reqIndex.set(e.seq, { name, primary: primaryArg(name, tc.function?.arguments ?? tc.arguments ?? tc.args) });
    }
  }
  return { reqIndex, resSeq };
}

/* one llm.call + the same-agent tool_result (and, in old streams, tool_call)
   agent.events that follow it, up to the next llm.call. The pi normalizer no longer
   emits standalone tool_call events — requests live in response.message.tool_calls
   (with ids) and results pair back via data.tool_call_id; absorbing tool_call here
   is the compatibility path for archived runs. Recomputed per render: tool events
   landing in a later poll join their turn card automatically. */
export function groupEvents(events: Ev[]): StreamItem[] {
  const items: StreamItem[] = [];
  const consumed = new Set<number>();
  for (let i = 0; i < events.length; i++) {
    if (consumed.has(i)) continue;
    const e = events[i]!;
    if (e.type !== "llm.call") {
      items.push({ kind: "row", e });
      continue;
    }
    const tools: Ev[] = [];
    for (let j = i + 1; j < events.length; j++) {
      const f = events[j]!;
      if (f.type === "llm.call") break;
      if (f.type === "agent.event" && (f.kind === "tool_call" || f.kind === "tool_result")
          && f.agent === e.agent) {
        tools.push(f);
        consumed.add(j);
      }
    }
    items.push({ kind: "turn", call: e, tools });
  }
  return items;
}

/* ---------------- turn card ---------------- */

/* requested call (from response.message.tool_calls, kept verbatim by the
   normalizer) — tolerate OpenAI nesting or flat {name, arguments} */
function toolName(tc: Ev): string {
  return String(tc.function?.name ?? tc.name ?? tc.tool ?? "tool");
}
function toolArgs(tc: Ev): string {
  const a = tc.function?.arguments ?? tc.arguments ?? tc.args;
  if (a === undefined) return "";
  if (typeof a === "string") {
    try { return JSON.stringify(JSON.parse(a), null, 2); } catch { return a; }
  }
  return JSON.stringify(a, null, 2);
}
/* what the tool acted on — shown in the collapsed chip/row header itself:
   path-shaped tools → path/file/filename, shell-shaped → command, else the first
   string-valued argument */
function primaryArg(name: string, args: unknown): string {
  let a: Ev | undefined;
  if (typeof args === "string") {
    try { a = JSON.parse(args) as Ev; } catch { return args; }
  } else if (args && typeof args === "object" && !Array.isArray(args)) a = args as Ev;
  if (!a) return "";
  const strOf = (keys: string[]) => {
    for (const k of keys) if (typeof a![k] === "string") return a![k] as string;
    return undefined;
  };
  if (/(read|write|edit|open|view|cat|file)/i.test(name)) {
    const p = strOf(["path", "file", "filename", "file_path"]);
    if (p) return p;
  }
  if (/(bash|exec|shell|run|cmd|terminal)/i.test(name)) {
    const c = strOf(["command", "cmd", "script"]);
    if (c) return c;
  }
  const generic = strOf(["path", "file", "filename", "command", "query", "url"]);
  if (generic) return generic;
  const first = Object.values(a).find((v) => typeof v === "string");
  return typeof first === "string" ? first : "";
}

/* middle-truncate to one line, keeping the TAIL — for paths the filename matters
   more than the directory prefix */
/* NO fixed-char truncation in summary lines: the full text goes into the DOM and
   CSS clamps it to the available width on ONE line. A tail is pinned ONLY when the
   last whitespace-separated token is genuinely path-like (contains "/" or ends in
   a dot-extension) — a flag like "-100" is never split off; everything else is a
   single plain truncating span. The tail span carries its own LEADING separator
   (space or "/") with whitespace-pre, so the gap can't be collapsed away when the
   head truncates. Full text in the tooltip. */
function splitTail(s: string): [string, string] {
  const t = s.replace(/\s+/g, " ").trim();
  const lastSpace = t.lastIndexOf(" ");
  const lastTok = t.slice(lastSpace + 1);
  const pathLike = lastTok.includes("/") || /\.[A-Za-z0-9]{1,8}$/.test(lastTok);
  if (!pathLike) return [t, ""];
  /* pin the basename (or space-separated filename), keeping its separator */
  const cut = Math.max(t.lastIndexOf("/"), lastSpace);
  const tail = t.slice(cut); /* includes the leading "/" or " " */
  if (cut <= 0 || tail.length < 3 || tail.length > 40) return [t, ""];
  return [t.slice(0, cut), tail];
}

const TailClamp = ({ text, className }: { text: string; className?: string }) => {
  const [head, tail] = splitTail(text);
  return (
    <span
      title={text}
      className={cn("flex min-w-0 max-w-full flex-nowrap overflow-hidden", className)}
    >
      <span className="min-w-0 truncate">{head}</span>
      {tail && <span className="shrink-0 whitespace-pre">{tail}</span>}
    </span>
  );
};

function prettyArgs(args: unknown): string | null {
  if (args === undefined || args === null) return null;
  if (typeof args === "string") {
    /* old runs carried JSON-string arguments; the normalizer now unwraps them,
       this parse is the fallback for archived data */
    try { return JSON.stringify(JSON.parse(args), null, 2); } catch { return args; }
  }
  return JSON.stringify(args, null, 2);
}

function resultOutput(res: Ev | undefined): string | null {
  const d = res?.data ?? {};
  const out = d.output ?? d.output_tail ?? d.tail ?? d.result ?? d.content;
  if (out === undefined || out === null) return null;
  if (isElided(out)) return elStr(out);
  return typeof out === "string" ? out : JSON.stringify(out, null, 2);
}

function ToolChip({ name, args, primary, callEv, resultEv, onExpand }: {
  name: string; args: string; primary: string; callEv?: Ev; resultEv?: Ev;
  onExpand?: () => void;
}) {
  const v = verdict(resultEv?.data);
  const out = resultOutput(resultEv);
  const raws = [callEv, resultEv].filter((x): x is Ev => !!x);
  const headline = primary || args;
  const hue = toolHue(name);
  return (
    <details
      className="rounded-md border bg-muted/30"
      onToggle={(ev) => { if ((ev.target as HTMLDetailsElement).open) onExpand?.(); }}
    >
      <summary className="flex flex-nowrap cursor-pointer items-baseline gap-2 px-2 py-1 hover:bg-muted/50 [&::-webkit-details-marker]:hidden">
        <Wrench className={cn("size-3 shrink-0 self-center", hue)} />
        <span className={cn("font-mono text-xs font-semibold", hue)}>{name}</span>
        {headline && (
          <TailClamp text={headline} className="font-mono text-[11px] text-muted-foreground" />
        )}
        <span className="ml-auto flex shrink-0 items-baseline gap-2">
          <ToolOutcomeChip name={name} exitCode={resultEv?.data?.exit_code} v={v} />
          {!resultEv && <span className="text-[10px] text-muted-foreground">no result yet</span>}
        </span>
      </summary>
      <div className="space-y-1.5 border-t px-2 py-1.5">
        {args && (
          <>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">args</div>
            <JsonPre src={args} />
          </>
        )}
        {out !== null && (
          <>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">result</div>
            <ClampedMono text={out} />
          </>
        )}
        {raws.length > 0 && <RawDetails events={raws} />}
      </div>
    </details>
  );
}

function TurnCard({ call: callProp, tools, gutters, profile, gutterMode, fetchFull }: {
  call: Ev; tools: Ev[]; gutters: Map<unknown, GutterInfo>; profile: StreamProfile;
  gutterMode: GutterMode; fetchFull?: (seq: unknown) => Promise<Ev | null>;
}) {
  /* wire-diet: previews render from the elided event; expanding an elided
     section swaps in the full event (fetched once, cached) */
  const [full, setFull] = useState<Ev | null>(null);
  const [loadingFull, setLoadingFull] = useState(false);
  const call = full ?? callProp;
  const elided = full === null && hasElisions(callProp);
  const ensureFull = () => {
    if (full || !fetchFull || !elided) return;
    setLoadingFull(true);
    void fetchFull(callProp.seq).then((f) => { if (f) setFull(f); setLoadingFull(false); });
  };
  const resp = call.response?.message;
  const u = call.usage ?? {};
  const content = elStr(resp?.content);
  const reasoning = elStr(resp?.reasoning_content);
  const respCalls: Ev[] = Array.isArray(resp?.tool_calls) ? resp.tool_calls : [];
  const callEvs = tools.filter((t) => t.kind === "tool_call");
  const resultEvs = tools.filter((t) => t.kind === "tool_result");
  const lastSeq = tools.length ? tools[tools.length - 1]!.seq : call.seq;

  /* result → requested call: STRICTLY by tool_call_id when both sides carry ids
     (the new normalizer shape); order fallback only for id-less old data */
  const resultsHaveIds = resultEvs.some((r) => (r.data?.tool_call_id ?? r.data?.id) !== undefined);
  const resultFor = (tc: Ev | undefined, i: number): Ev | undefined => {
    const id = tc?.id ?? tc?.tool_call_id;
    if (id !== undefined && resultsHaveIds)
      return resultEvs.find((r) => (r.data?.tool_call_id ?? r.data?.id) === id);
    return resultEvs[i];
  };
  /* legacy standalone tool_call events: attach to an in-response request by id,
     else by order WHEN the name agrees — otherwise leave unmatched (rendered as
     an extra chip below, never silently dropped) */
  const callEvFor = (tc: Ev | undefined, i: number): Ev | undefined => {
    const id = tc?.id ?? tc?.tool_call_id;
    if (id !== undefined) {
      const hit = callEvs.find((c) => (c.data?.tool_call_id ?? c.data?.id) === id);
      if (hit) return hit;
    }
    const byOrder = callEvs[i];
    if (!byOrder) return undefined;
    const evName = String(byOrder.data?.name ?? byOrder.data?.tool ?? "");
    return !evName || !tc || evName === toolName(tc) ? byOrder : undefined;
  };
  /* chips come from the model's requested tool_calls; if the normalizer gave none
     but the harness emitted tool_call events, fall back to those */
  const chips = respCalls.length
    ? respCalls.map((tc, i) => ({
        key: String(tc.id ?? i),
        name: toolName(tc),
        args: toolArgs(tc),
        primary: primaryArg(toolName(tc), tc.function?.arguments ?? tc.arguments ?? tc.args),
        callEv: callEvFor(tc, i),
        resultEv: resultFor(tc, i),
      }))
    : callEvs.map((c, i) => ({
        key: String(c.seq),
        name: String(c.data?.name ?? c.data?.tool ?? "tool"),
        args: c.data?.args !== undefined ? JSON.stringify(c.data.args, null, 2) : "",
        primary: primaryArg(String(c.data?.name ?? c.data?.tool ?? "tool"), c.data?.args),
        callEv: c,
        resultEv: resultFor(c.data, i),
      }));
  /* legacy tool_call events that matched no in-response request (name/order
     mismatch) still render — as their own chips, never double-shown */
  const matched = new Set(chips.map((c) => c.callEv).filter(Boolean));
  const extraChips = respCalls.length
    ? callEvs.filter((c) => !matched.has(c)).map((c, i) => ({
        key: `x${c.seq}`,
        name: String(c.data?.name ?? c.data?.tool ?? "tool"),
        args: c.data?.args !== undefined ? JSON.stringify(c.data.args, null, 2) : "",
        primary: primaryArg(String(c.data?.name ?? c.data?.tool ?? "tool"), c.data?.args),
        callEv: c,
        resultEv: undefined as Ev | undefined,
      }))
    : [];

  /* three independent optional components — "empty" means ALL absent */
  const emptyResp = !call.error && !content.trim() && !reasoning.trim() && !chips.length
    && (u.output_tokens === 0 || u.output_tokens === undefined);

  /* seq-range becomes a time-range; seqs + absolute ts stay in the tooltip */
  const g0 = gutters.get(call.seq);
  const g1 = tools.length ? gutters.get(lastSeq) : undefined;
  const range = g0
    ? g1 && g1.label !== g0.label
      ? `${g0.label}–${gutterMode === "absolute" ? trimCommon(g0.label, g1.label) : g1.label.replace(/^\+/, "")}`
      : g0.label
    : "";
  const gTitle = `llm.call · seq ${fmtVal(call.seq)}${tools.length ? `–${fmtVal(lastSeq)}` : ""}`
    + `${call.via ? ` · via ${String(call.via)}` : ""}${call.ts ? ` · ${call.ts}` : ""}`;
  return (
    <div id={`ev-${String(call.seq)}`} className="border-b border-l-2 border-border/60 border-l-violet-500/40 px-2 py-1.5 last:border-b-0">
      {/* header */}
      <div className="flex items-baseline gap-2">
        <span
          title={gTitle}
          className={cn(
            "w-14 shrink-0 select-none text-right font-mono text-muted-foreground/70",
            range.includes("–") ? "text-[9px]" : "text-[10px]",
          )}
        >
          {range}
        </span>
        <Sparkles className="size-3.5 shrink-0 self-center text-violet-600 dark:text-violet-400" />
        <span
          className="shrink-0 rounded bg-violet-500/15 px-1.5 font-mono text-[10px] leading-4 text-violet-700 dark:text-violet-400"
          title="one model call + the tool results it caused — a derived grouping; the underlying llm.call event is in the raw details"
        >
          turn
        </span>
        <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-2 text-sm">
          {profile.showAgent && <span className="font-semibold">{call.agent}</span>}
          {call.error && (
            <span className={cn("rounded px-1 font-mono text-[10px]", RED)}>{call.error.kind}</span>
          )}
          {emptyResp && (
            <span className={EMPTY_FLAG} title="no reasoning, no text, no tool calls, no output tokens — a dead model turn">
              empty response
            </span>
          )}
        </span>
      </div>
      {/* body */}
      <div className="space-y-1.5 py-1 pl-[5.7rem] pr-1">
        <FactsLine e={call} />
        {call.error ? (
          <div className="text-sm text-red-700 dark:text-red-400">
            error: {call.error.kind} — {call.error.message}
          </div>
        ) : (
          <>
            {reasoning.trim() && <ReasoningBlock text={reasoning} />}
            {content.trim() && <MdView src={content} />}
            {elided && (containsElision(resp?.content) || containsElision(resp?.reasoning_content)) && (
              <LoadFullButton onLoad={ensureFull} loading={loadingFull} />
            )}
            {[...chips, ...extraChips].map((c) => (
              <ToolChip key={c.key} name={c.name} args={c.args} primary={c.primary}
                callEv={c.callEv} resultEv={c.resultEv} onExpand={ensureFull} />
            ))}
          </>
        )}
        {call.request ? (
          <details onToggle={(ev) => { if ((ev.target as HTMLDetailsElement).open) ensureFull(); }}>
            <summary
              className="cursor-pointer text-[10px] uppercase tracking-wider text-muted-foreground"
              title={reqLabel(call).title}
            >
              {reqLabel(call).text}{elided ? " · elided, opens full" : ""}
            </summary>
            <JsonPre className="mt-1" src={JSON.stringify(call.request, null, 2)} />
          </details>
        ) : null}
        <RawDetails events={[call, ...tools]} onOpen={ensureFull} />
      </div>
    </div>
  );
}

/* ---------------- one row (non-turn events) ---------------- */

function Row({ e: eProp, req, links, profile, gutter, onJump, fetchFull }: {
  e: Ev;
  req?: { name: string; primary: string };
  links?: Map<string, unknown>;
  profile: StreamProfile;
  gutter?: GutterInfo;
  onJump?: (seq: unknown) => void;
  fetchFull?: (seq: unknown) => Promise<Ev | null>;
}) {
  /* wire-diet: render from the (possibly elided) event; expanding an elided
     section swaps in the full one */
  const [full, setFull] = useState<Ev | null>(null);
  const [loadingFull, setLoadingFull] = useState(false);
  const e = full ?? eProp;
  const elided = full === null && hasElisions(eProp);
  const ensureFull = () => {
    if (full || !fetchFull || !elided) return;
    setLoadingFull(true);
    void fetchFull(eProp.seq).then((f) => { if (f) setFull(f); setLoadingFull(false); });
  };
  let s = STYLES[e.type] ?? FALLBACK;
  let summary: ReactNode = null;
  let payload: ReactNode = null;
  const inherited = e.type === "message" && !!e.meta?.inherited;
  const quiet = e.type === "status" || e.type === "run.status";

  if (e.type === "llm.call") {
    const u = e.usage ?? {};
    const resp = e.response?.message;
    const respCalls: Ev[] = Array.isArray(resp?.tool_calls) ? resp.tool_calls : [];
    const content = elStr(resp?.content);
    const reasoning = elStr(resp?.reasoning_content);
    /* reasoning, message text, and tool calls are THREE independent optional
       components; a turn is only "empty" when ALL are absent (~0 output tokens) */
    const emptyResp = !e.error && !content.trim() && !reasoning.trim() && !respCalls.length
      && (u.output_tokens === 0 || u.output_tokens === undefined);
    if (e.error) s = { ...s, badge: RED, icon: RED_ICON };
    const toolSum = toolsSummary(respCalls.map((tc) => ({
      name: toolName(tc),
      primary: primaryArg(toolName(tc), tc.function?.arguments ?? tc.arguments ?? tc.args),
    })));
    summary = (
      <>
        {profile.showAgent && <span className="font-semibold">{e.agent}</span>}
        {e.error && (
          <span className={cn("rounded px-1 font-mono text-[10px]", RED)}>{e.error.kind}</span>
        )}
        {emptyResp && (
          <span className={EMPTY_FLAG} title="no reasoning, no text, no tool calls, no output tokens — a dead model turn">
            empty response
          </span>
        )}
        {/* collapsed-row preview: first ~2 clamped lines of whichever component
            exists, flowing INLINE right after the agent chip (no reserved slot,
            no indent) — the stream reads as a trajectory without opening
            anything. Hidden once the row is open. */}
        {(content.trim() || reasoning.trim() || toolSum) && (
          <span className={cn(
            "line-clamp-2 min-w-0 flex-1 whitespace-pre-wrap text-xs group-open:hidden",
            content.trim() ? "text-muted-foreground"
              : reasoning.trim() ? "italic text-muted-foreground"
              : "font-mono text-[11px] text-muted-foreground",
          )}>
            {content.trim() ? content : reasoning.trim() ? `thinking: ${reasoning}` : `→ ${toolSum}`}
          </span>
        )}
      </>
    );
    payload = e.error ? (
      <>
        <FactsLine e={e} />
        <div className="text-sm text-red-700 dark:text-red-400">
          error: {e.error.kind} — {e.error.message}
        </div>
      </>
    ) : reasoning.trim() || content.trim() || respCalls.length || e.request ? (
      <>
        <FactsLine e={e} />
        {reasoning.trim() && <ReasoningBlock text={reasoning} />}
        {content.trim() && <MdView src={content} />}
        {elided && (isElided(resp?.content) || isElided(resp?.reasoning_content)) && (
          <LoadFullButton onLoad={ensureFull} loading={loadingFull} />
        )}
        {respCalls.map((tc, i) => {
          const name = toolName(tc);
          const hue = toolHue(name);
          const target = links?.get(`${String(e.seq)}:${tc.id !== undefined ? String(tc.id) : `i${i}`}`);
          const inner = (
            <>
              <Wrench className={cn("size-3 shrink-0 self-center", hue)} />
              <span className={cn("font-mono text-xs font-semibold", hue)}>{name}</span>
              <TailClamp
                text={primaryArg(name, tc.function?.arguments ?? tc.arguments ?? tc.args)}
                className="font-mono text-[11px] text-muted-foreground"
              />
            </>
          );
          /* the request line LINKS to its result row (id match, order fallback):
             smooth-scroll + nav-glow flash. No result (yet) → inert with a hint. */
          return target !== undefined ? (
            <button
              key={String(tc.id ?? i)}
              type="button"
              onClick={(ev) => { ev.stopPropagation(); (onJump ?? flashRow)(target); }}
              title="jump to this call's result"
              className="flex w-full flex-nowrap cursor-pointer items-baseline gap-2 rounded-md border bg-muted/30 px-2 py-1 text-left hover:border-primary/60"
            >
              {inner}
              <span className="ml-auto shrink-0 font-mono text-[10px] text-primary">→ result</span>
            </button>
          ) : (
            <div key={String(tc.id ?? i)} className="flex flex-nowrap items-baseline gap-2 rounded-md border bg-muted/30 px-2 py-1">
              {inner}
              <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">no result</span>
            </div>
          );
        })}
        {e.request ? (
          <details onToggle={(ev) => { if ((ev.target as HTMLDetailsElement).open) ensureFull(); }}>
            <summary
              className="cursor-pointer text-[10px] uppercase tracking-wider text-muted-foreground"
              title={reqLabel(e).title}
            >
              {reqLabel(e).text}{elided ? " · elided, opens full" : ""}
            </summary>
            <JsonPre className="mt-1" src={JSON.stringify(e.request, null, 2)} />
          </details>
        ) : null}
      </>
    ) : null;
  } else if (e.type === "message") {
    summary = (
      <>
        <span className="font-semibold">{e.from}</span>
        {e.to ? <span className="text-muted-foreground">→ {e.to}</span> : null}
        {profile.showChannel && (
          <span className={cn("font-mono text-xs", channelHue(e.channel))}>#{e.channel}</span>
        )}
        {e.meta?.kind ? (
          <span className={cn("rounded px-1 font-mono text-[10px]", AMBER)}>{e.meta.kind}</span>
        ) : null}
        <InheritedBadge ev={e} />
        <span className="truncate text-muted-foreground">{firstLine(elStr(e.content))}</span>
      </>
    );
    payload = (
      <>
        <MdView src={elStr(e.content)} />
        {elided && isElided(e.content) && <LoadFullButton onLoad={ensureFull} loading={loadingFull} />}
      </>
    );
  } else if (e.type === "agent.event") {
    const d: Ev = e.data ?? {};
    const v = verdict(d);
    if (v === false) s = { ...s, badge: RED, icon: RED_ICON };
    const tail = typeof d.tail === "string" ? d.tail : typeof d.output_tail === "string" ? d.output_tail : null;
    const toolish = e.kind === "tool_call" || e.kind === "tool_result";
    /* result events now carry their own request (data.arguments, alongside
       tool/tool_call_id/output) — render from OWN data first; the buildReqIndex
       join is the fallback for old streams whose results lack arguments */
    const ownArgs = d.arguments ?? d.args;
    const tName = toolish ? String(d.name ?? d.tool ?? "") || (req?.name ?? "") : "";
    const tPrimary = toolish ? primaryArg(tName || "tool", ownArgs) || (req?.primary ?? "") : "";
    const hasExit = typeof d.exit_code === "number";
    const matchId = d.tool_call_id ?? d.id;
    /* the row's visual identity is the TOOL, not the uniform event-type amber */
    if (toolish && tName) s = { ...s, icon: toolHue(tName) };
    if (toolish) {
      /* an ACTION's summary shows action facts ONLY: colored icon + tool name +
         primary arg as one unit, plus the outcome chip per shape. Output belongs
         in the expansion, never the summary. */
      summary = (
        <>
          {profile.showAgent && <span className="font-semibold">{e.agent}</span>}
          <span className="flex min-w-0 flex-1 flex-nowrap items-baseline gap-1.5">
            <span className={cn("shrink-0 font-mono text-xs font-semibold", toolHue(tName || "tool"))}>
              {tName || e.kind}
            </span>
            {tPrimary && (
              <TailClamp text={tPrimary} className="font-mono text-[11px] text-muted-foreground" />
            )}
          </span>
          <ToolOutcomeChip name={tName} exitCode={d.exit_code} v={v} />
        </>
      );
    } else if (e.kind === "instance" || e.kind === "sample" /* legacy */) {
      /* instance close-out (docs/plan/events.md): id + repeat + its scores as
         chips, so each unit's outcome reads inline without opening the row */
      const scores = d.scores && typeof d.scores === "object" && !Array.isArray(d.scores)
        ? flattenScores(d.scores as Record<string, unknown>) : [];
      summary = (
        <>
          {profile.showAgent && <span className="font-semibold">{e.agent}</span>}
          <span className={cn("rounded px-1 font-mono text-[10px]", s.badge)}>
            instance {fmtVal(d.id)}
          </span>
          {(d.repeat ?? d.epoch) !== undefined && (d.repeat ?? d.epoch) !== 1 ? (
            <span className="font-mono text-[10px] text-muted-foreground">
              repeat {fmtVal(d.repeat ?? d.epoch)}
            </span>
          ) : null}
          {d.error ? <span className={cn("rounded px-1 font-mono text-[10px]", RED)}>error</span> : null}
          <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1 overflow-hidden">
            {scores.map((sc) => <ResultChip key={sc.name} name={sc.name} value={sc.value} />)}
          </span>
        </>
      );
    } else {
      summary = (
        <>
          {profile.showAgent && <span className="font-semibold">{e.agent}</span>}
          <span className={cn("rounded px-1 font-mono text-[10px]", s.badge)}>{e.kind}</span>
          {d.language ? <span className="font-mono text-xs text-muted-foreground">{d.language}</span> : null}
          {hasExit ? <ExitBadge code={d.exit_code} /> : <VerdictBadge v={v} />}
          <span className="truncate font-mono text-xs text-muted-foreground">
            {firstLine(d.command ?? tail ?? d.reason ?? "")}
          </span>
        </>
      );
    }
    if (e.kind === "tool_call") {
      const argsPretty = prettyArgs(ownArgs);
      const shellCmd = /(bash|exec|shell|run|cmd|terminal)/i.test(tName) ? tPrimary : "";
      payload = shellCmd || argsPretty !== null ? (
        <>
          {shellCmd && <Mono className="font-semibold">{shellCmd}</Mono>}
          {argsPretty !== null && (
            <>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">args</div>
              <JsonPre src={argsPretty} />
            </>
          )}
        </>
      ) : null;
    } else if (e.kind === "tool_result") {
      const out = resultOutput(e);
      /* own executed-args (new shape) — in new streams the result row is the only
         flat-view home for them (no tool_call rows exist by construction) */
      const argsPretty = d.arguments !== undefined ? prettyArgs(d.arguments) : null;
      payload = out !== null || argsPretty !== null ? (
        <>
          {argsPretty !== null && (
            <>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">args</div>
              <JsonPre src={argsPretty} />
            </>
          )}
          {out !== null && (
            <>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">output</div>
              <Mono>{out}</Mono>
            </>
          )}
          {elided && <LoadFullButton onLoad={ensureFull} loading={loadingFull} />}
        </>
      ) : null;
    } else {
      const rest = Object.fromEntries(
        Object.entries(d).filter(([k]) => !["command", "tail", "output_tail"].includes(k)));
      payload = d.command || tail || Object.keys(rest).length > 0 ? (
        <>
          {d.command ? <Mono>{String(d.command)}</Mono> : null}
          {tail ? <Mono>{tail}</Mono> : null}
          {Object.keys(rest).length > 0 && (
            <JsonPre src={JSON.stringify(rest, null, 2)} />
          )}
        </>
      ) : null;
    }
  } else if (e.type === "metric") {
    /* the ResultChip language — same as the run page results strip */
    summary = (
      <>
        <ResultChip name={String(e.name)} value={e.value} unit={e.unit as string | null} />
        {e.step !== null && e.step !== undefined ? (
          <span className="text-xs text-muted-foreground">@ step {fmtVal(e.step)}</span>
        ) : null}
      </>
    );
  } else if (e.type === "artifact") {
    const mt = String(e.media_type ?? "");
    const FileIcon = mt.startsWith("image/") ? Image : mt.includes("json") ? FileJson : FileText;
    summary = (
      <>
        <FileIcon className="size-3.5 self-center text-cyan-600 dark:text-cyan-400" />
        <span className="font-mono text-xs font-semibold">{fmtVal(e.name)}</span>
        <span className="text-xs text-muted-foreground">{fmtBytes(e.bytes)}</span>
        {mt && <span className="rounded bg-muted px-1 font-mono text-[10px] text-muted-foreground">{mt}</span>}
        {e.path ? <span className="truncate font-mono text-[11px] text-muted-foreground">{e.path}</span> : null}
      </>
    );
  } else if (e.type === "stdout" || e.type === "stderr") {
    /* captured process output (runner-synthesized) — no level, just the line.
       The open row always shows the full line as selectable text (the header
       truncates), never only the raw-JSON fallback. */
    summary = (
      <>
        <span className={cn("rounded px-1 font-mono text-[10px]", s.badge)}>{e.type}</span>
        <span className="truncate font-mono text-xs text-muted-foreground">{firstLine(e.line)}</span>
      </>
    );
    payload = <Mono>{String(e.line ?? "")}</Mono>;
  } else if (e.type === "log") {
    const lvl = String(e.level ?? "info");
    if (/err/i.test(lvl)) s = { ...s, badge: RED, icon: RED_ICON };
    else if (/warn/i.test(lvl)) s = { ...s, badge: AMBER, icon: "text-amber-600 dark:text-amber-400" };
    summary = (
      <>
        <span className={cn("rounded px-1 font-mono text-[10px]", s.badge)}>{lvl}</span>
        <span className="truncate text-muted-foreground">{firstLine(e.message)}</span>
      </>
    );
    /* the message IS the payload — a long single-line error (a common shape: one
       sentence with the fix in backticks) must be readable and copyable at row-open,
       not truncated in the header with only raw JSON behind it */
    payload = <Mono>{String(e.message ?? "")}</Mono>;
  } else if (quiet) {
    /* narration — keep it visually quiet */
    summary = (
      <span className="truncate text-xs italic text-muted-foreground/80">{e.detail ?? e.phase}</span>
    );
  } else if (e.type === "run.start") {
    summary = (
      <span className="text-muted-foreground">
        <b className="text-foreground">{e.experiment}</b> · seed {fmtVal(e.seed)} · replicate {fmtVal(e.replicate)}
      </span>
    );
  } else if (e.type === "run.end") {
    if (e.phase !== "completed") s = { ...s, badge: RED, icon: RED_ICON };
    const u = e.usage_totals ?? {};
    summary = (
      <>
        <PhaseBadge phase={e.phase} className="text-[10px]" />
        <span className="text-muted-foreground">
          {fmtVal(e.duration_s)}s · {fmtVal(u.llm_calls)} calls · {fmtVal(u.input_tokens)}+{fmtVal(u.output_tokens)} tok
        </span>
      </>
    );
  } else {
    /* generous cap for perf only — CSS still clamps to width */
    summary = <span className="truncate font-mono text-xs text-muted-foreground">{JSON.stringify(e).slice(0, 300)}</span>;
  }

  const { Icon } = s;
  /* everything stripped from the header stays discoverable here */
  const rowTitle = `${e.type}${e.kind ? ` · ${e.kind}` : ""} · seq ${fmtVal(e.seq)}`
    + `${e.type === "agent.event" && (e.data?.tool_call_id ?? e.data?.id) !== undefined
        ? ` · for ${fmtVal(e.data?.tool_call_id ?? e.data?.id)}` : ""}`
    + `${e.via ? ` · via ${String(e.via)}` : ""}`;
  return (
    <details
      id={`ev-${String(e.seq)}`}
      className={cn("group border-b border-border/60 last:border-b-0", inherited && "opacity-60")}
    >
      <summary
        title={rowTitle}
        className={cn(
        "flex cursor-pointer items-baseline gap-2 px-2 hover:bg-muted/40 [&::-webkit-details-marker]:hidden",
        quiet ? "py-0.5" : "py-1",
      )}>
        <Gutter g={gutter} />
        <Icon className={cn("shrink-0 self-center", s.icon, quiet ? "size-3 opacity-60" : "size-3.5")} />
        <span className="flex min-w-0 flex-1 items-baseline gap-2 text-sm">{summary}</span>
      </summary>
      <div className="space-y-1.5 py-1.5 pl-[5.7rem] pr-3">
        {payload != null ? (
          <>
            {payload}
            <RawDetails events={[e]} onOpen={ensureFull} />
          </>
        ) : (
          /* collapse-nesting rule: no native sections → the raw JSON IS the
             payload, directly visible at row-open (never behind a second fold) */
          <JsonPre src={JSON.stringify(e, null, 2)} />
        )}
      </div>
    </details>
  );
}

/* ---------------- the pane ---------------- */

/* the channel ("room") an event belongs to: messages carry it explicitly; other
   tagged events derive theirs from the sample tag — llm.call meta, source-captured
   stdout, and instance close-outs all land in the same `instance:<id>` room */
export const evChannel = (e: Ev): string | null => {
  if (typeof e.channel === "string")
    /* legacy streams roomed instances as sample:<id> (pre-spec inspect
       vocabulary) — normalize so old and new runs read as the same room kind */
    return e.channel.startsWith("sample:") ? `instance:${e.channel.slice(7)}` : e.channel;
  const sid = e.meta?.instance_id ?? e.meta?.sample_id ?? e.sample_id
    ?? (e.type === "agent.event" && (e.kind === "instance" || e.kind === "sample")
        ? e.data?.id : undefined);
  return sid === undefined || sid === null ? null : `instance:${String(sid)}`;
};

export function EventStream({ events, phase, mode = "flat", cid, rid }: {
  events: Ev[]; phase: string; mode?: "flat" | "turns"; cid?: string; rid?: string;
}) {
  const paneRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const [following, setFollowing] = useState(true);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(600);
  /* fullscreen: same component, same DOM, different frame — the pane keeps its
     scroll position, follow state, and fetched-full cache across the toggle */
  const [expanded, setExpanded] = useState(false);

  /* auto-follow while the user hasn't scrolled up */
  useEffect(() => {
    const el = paneRef.current;
    if (el && followRef.current) el.scrollTop = el.scrollHeight;
  }, [events.length]);
  useEffect(() => {
    const el = paneRef.current;
    if (el) setViewH(el.clientHeight || 600);
  }, [expanded]);
  useEffect(() => {
    if (!expanded) return;
    const onKey = (ev: KeyboardEvent) => { if (ev.key === "Escape") setExpanded(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  const onScroll = () => {
    const el = paneRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    followRef.current = atBottom;
    setFollowing(atBottom);
    setScrollTop(el.scrollTop);
    if (el.clientHeight && el.clientHeight !== viewH) setViewH(el.clientHeight);
  };
  const jump = () => {
    const el = paneRef.current;
    if (!el) return;
    followRef.current = true;
    setFollowing(true);
    el.scrollTop = el.scrollHeight;
    setScrollTop(el.scrollTop);
  };

  const live = phase === "running";
  const fetchFull = cid && rid
    ? (seq: unknown) => fetchFullEvent(cid, rid, seq)
    : undefined;

  /* channel filter: pick one room (e.g. #instance:lcbhard_0) and see only its
     events — with parallel instances the flat stream is their interleaving, so
     the room view is how one unit's trajectory stays readable. Options come from
     the FULL stream so the select never loses entries while filtered. */
  const [channelPick, setChannelPick] = useState<string | null>(null);
  const channels: string[] = [];
  for (const e of events) {
    const c = evChannel(e);
    if (c && !channels.includes(c)) channels.push(c);
  }
  const shown = channelPick ? events.filter((e) => evChannel(e) === channelPick) : events;

  const { reqIndex, resSeq } = buildLinkIndexes(shown);
  const profile = deriveProfile(shown);
  /* user toggle wins (persisted for the session); the profile supplies the
     default — the future manifest hint lands there */
  const [gModePick, setGModePick] = useState<GutterMode | null>(uiState.gutterMode ?? null);
  const gutterMode = gModePick ?? profile.gutterMode;
  const setGutterMode = (m: string) => {
    uiState.gutterMode = m as GutterMode;
    setGModePick(m as GutterMode);
  };
  const gutters = buildGutters(shown, gutterMode);
  const items: StreamItem[] = mode === "turns"
    ? groupEvents(shown)
    : shown.map((e) => ({ kind: "row", e }));

  /* ---------- windowed rendering (hand-rolled, no dependency) ----------
     A 5000-event stream must not build 5000 DOM nodes: above the threshold we
     render only the rows near the viewport between two spacer divs sized by a
     per-mode height estimate. Auto-follow keeps working: scrolling to the
     (spacer-inflated) bottom updates scrollTop, which selects the tail window. */
  const VIRT_AT = 200;
  const EST = mode === "turns" ? 120 : 34;
  const virt = items.length > VIRT_AT;
  const OVERSCAN = 30;
  const start = virt ? Math.max(0, Math.floor(scrollTop / EST) - OVERSCAN) : 0;
  const end = virt
    ? Math.min(items.length, Math.ceil((scrollTop + viewH) / EST) + OVERSCAN)
    : items.length;
  const windowed = items.slice(start, end);

  /* jump that works when the target row isn't rendered yet: scroll the window
     there first, then flash */
  const jumpToSeq = (seq: unknown) => {
    const el = document.getElementById(`ev-${String(seq)}`);
    if (el) { flashRow(seq); return; }
    const idx = shown.findIndex((x) => x.seq === seq);
    const pane = paneRef.current;
    if (idx < 0 || !pane) return;
    pane.scrollTop = Math.max(0, idx * EST - viewH / 2);
    setScrollTop(pane.scrollTop);
    setTimeout(() => flashRow(seq), 80);
  };
  return (
    <>
    {expanded && (
      <div className="fixed inset-0 z-40 bg-black/60" onClick={() => setExpanded(false)} />
    )}
    <div className={cn(
      "flex flex-col overflow-hidden rounded-lg border bg-card",
      expanded ? "fixed inset-3 z-50 shadow-2xl" : "h-full",
    )}>
      {/* pane header: the liveness dot sits HERE, next to the stream it vouches
          for, adjacent to the auto-follow control */}
      <div className="flex items-center gap-3 border-b bg-muted/30 px-2.5 py-1">
        <LiveDot phase={phase} />
        <span className="font-mono text-[11px] text-muted-foreground">
          {channelPick ? `${shown.length}/${events.length}` : events.length} events
        </span>
        <span className="ml-auto flex items-center gap-2.5">
          {channels.length > 1 && (
            <select
              value={channelPick ?? ""}
              onChange={(ev) => setChannelPick(ev.target.value || null)}
              title="filter to one channel — with parallel samples the flat stream is their interleaving"
              className="max-w-44 rounded border bg-background px-1 py-0.5 font-mono text-[11px] text-muted-foreground"
            >
              <option value="">all channels</option>
              {channels.map((c) => <option key={c} value={c}>#{c}</option>)}
            </select>
          )}
          <Segmented options={["absolute", "relative"]} value={gutterMode} onChange={setGutterMode} />
          {following ? (
            <span className="text-[11px] text-muted-foreground">
              {live ? "following — auto-scrolls on new events" : "at end"}
            </span>
          ) : (
            <button
              type="button"
              onClick={jump}
              className="inline-flex items-center gap-1.5 rounded-full border bg-background px-2.5 py-0.5 text-[11px] hover:bg-accent"
            >
              <ArrowDown className="size-3" />
              {live ? "following paused — jump to latest" : "jump to latest"}
            </button>
          )}
          <button
            type="button"
            onClick={() => setExpanded((x) => !x)}
            title={expanded ? "exit fullscreen (Esc)" : "fullscreen"}
            className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            {expanded ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
          </button>
        </span>
      </div>
      <AgentsLegend agents={profile.agents} />
      <div ref={paneRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
        {virt && start > 0 && <div style={{ height: start * EST }} aria-hidden />}
        {windowed.map((it) =>
          it.kind === "turn"
            ? <TurnCard key={`t${it.call.seq}`} call={it.call} tools={it.tools}
                gutters={gutters} profile={profile} gutterMode={gutterMode}
                fetchFull={fetchFull} />
            : <Row key={it.e.seq} e={it.e} req={reqIndex.get(it.e.seq)}
                links={resSeq} profile={profile} gutter={gutters.get(it.e.seq)}
                onJump={jumpToSeq} fetchFull={fetchFull} />)}
        {virt && end < items.length && <div style={{ height: (items.length - end) * EST }} aria-hidden />}
        {!shown.length && (
          <p className="p-3 text-sm text-muted-foreground">
            {events.length ? "no events in this channel" : "no events yet"}
          </p>
        )}
      </div>
    </div>
    </>
  );
}
