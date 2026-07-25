/* Shape-aware param value rendering. Short scalars stay inline chips; ADB registry
   types get purpose-built widgets (llm → provider/model chip, run → lineage-linked
   run chip, harness → structured card); long strings, markdown-looking blobs, and
   JSON-shaped values render as compact cards (name + one-line preview + size hint)
   that open a scrollable modal (rendered markdown or highlighted monospace, with
   copy).

   pickWidget() is the seam for docs/plan/v1.md §4's declarative presentation hints:
   today the widget is inferred from the value's shape; when hints land, a hint simply
   short-circuits the inference via the `hint` parameter.

   TODO(schema-driven): the REAL fix for registry types is driving from the
   experiment manifest's param schema (v0.md §4 plans the web server shipping the
   manifests derivation); the manifests haven't reached the server yet, so the
   llm/run/harness detection below is value-shape heuristics feeding the same hint
   seam. Replace the detection — not the rendering — when schemas arrive. */

import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, Copy, Cpu, GitBranch, Maximize2, Sparkles, X } from "lucide-react";
import { fetchParamValue, findRun, fmtVal, prefetchRun } from "@/lib/data";
import { LoadingBar } from "@/components/bits";
import type { ParamRef } from "@/shared/types";
import { navigateWithGlow } from "@/lib/nav";
import { highlightJson } from "@/lib/markdown";
import { Chip, MdView, Segmented } from "@/components/bits";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type ParamWidget =
  | "inline" | "text" | "markdown" | "json"   /* shape-inferred */
  | "llm" | "run" | "harness"                 /* ADB registry types */
  | "ref";                                     /* server-side {__param_ref} descriptor */

/* the server replaces large param values with descriptors; the full value is one
   fetch away (/api/params/<ref>), pulled when the modal opens */
export const isParamRef = (v: unknown): v is ParamRef =>
  !!v && typeof v === "object" && "__param_ref" in (v as object);

const BIG = 64; /* chars — beyond this a value stops being an inline chip */

const looksMarkdown = (s: string): boolean =>
  /^#{1,6}\s/.test(s.trimStart()) || s.includes("```") || /^\s*[-*]\s/m.test(s) || /\n#{1,6}\s/.test(s);

const parseJson = (s: string): unknown | undefined => {
  const t = s.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return undefined;
  try { return JSON.parse(t); } catch { return undefined; }
};

/* ---------------- registry-type heuristics (see TODO above) ---------------- */

/* 26-char Crockford base32 — a ULID, i.e. a run id (`run` registry type) */
const RUN_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
/* provider/model shape for the `llm` registry type; reject file-path lookalikes */
const LLM_RE = /^[a-z0-9][\w.-]*\/[\w.:/-]+$/i;
const FILEY_RE = /\.(md|ya?ml|json|txt|csv|py|ts|js|log)$/i;

const isHarnessObj = (v: unknown): boolean =>
  typeof v === "object" && v !== null && !Array.isArray(v) &&
  ("harness" in v || (v as Record<string, unknown>).kind === "adb-harness");

function detectRegistry(value: unknown, name?: string): ParamWidget | undefined {
  if (typeof value === "string") {
    if (RUN_ID_RE.test(value)) return "run";
    const namey = name !== undefined && /(^|_)(model|llm)s?($|_)/i.test(name);
    if (value.length <= BIG && !value.includes("\n") && !FILEY_RE.test(value) &&
        (namey || LLM_RE.test(value)) && (namey || value.includes("/")))
      return "llm";
    const parsed = parseJson(value); /* filter chips carry pre-formatted strings */
    if (parsed !== undefined && isHarnessObj(parsed)) return "harness";
    return undefined;
  }
  if (isHarnessObj(value)) return "harness";
  return undefined;
}

export function pickWidget(value: unknown, hint?: ParamWidget, name?: string): ParamWidget {
  if (hint) return hint; /* future: declarative presentation hints override inference */
  if (isParamRef(value)) return "ref";
  const reg = detectRegistry(value, name);
  if (reg) return reg;
  if (value !== null && typeof value === "object")
    return JSON.stringify(value).length > BIG ? "json" : "inline";
  if (typeof value === "string" && (value.length > BIG || value.includes("\n"))) {
    if (parseJson(value) !== undefined) return "json";
    return looksMarkdown(value) ? "markdown" : "text";
  }
  return "inline";
}

/* raw string for copy/modal + a compact size hint */
export function materialize(value: unknown, widget: ParamWidget): { raw: string; size: string } {
  if (typeof value === "string") {
    const parsed = widget === "json" || widget === "harness" ? parseJson(value) : undefined;
    const raw = parsed !== undefined ? JSON.stringify(parsed, null, 2) : value;
    const size = value.length > 1024
      ? `${(value.length / 1024).toFixed(1)} kB`
      : `${value.split("\n").length} lines`;
    return { raw, size };
  }
  const raw = JSON.stringify(value, null, 2);
  const size = Array.isArray(value)
    ? `${value.length} items`
    : `${Object.keys(value as object).length} keys`;
  return { raw, size };
}

const preview = (raw: string): string => {
  /* skip markdown frontmatter fences so previews show content, not "---" */
  const line = raw.split("\n").find((l) => l.trim() && !/^-{3,}$/.test(l.trim())) ?? "";
  return line.trim().slice(0, 40) + (line.trim().length > 40 || raw.includes("\n") ? " …" : "");
};

const asObject = (value: unknown): Record<string, unknown> =>
  (typeof value === "string" ? parseJson(value) ?? {} : value ?? {}) as Record<string, unknown>;

/* ---------------- the chip ---------------- */

/* One param, rendered by shape/type. With `onToggle` the chip body stays a filter
   toggle (as on the experiment page); modal/link affordances live on inner icons. */
export function ParamChip({
  name,
  value,
  active,
  onToggle,
  hint,
}: {
  name?: string;
  value: unknown;
  active?: boolean;
  onToggle?: () => void;
  hint?: ParamWidget; /* the presentation-hint seam — schema-driven someday */
}) {
  const [open, setOpen] = useState(false);
  const widget = pickWidget(value, hint, name);

  if (widget === "inline")
    return (
      <Chip active={active} onClick={onToggle}>
        {name !== undefined ? `${name}=${fmtVal(value)}` : fmtVal(value)}
      </Chip>
    );
  if (widget === "ref")
    return <RefChip name={name} desc={(value as ParamRef).__param_ref} active={active} onToggle={onToggle} />;
  if (widget === "llm") return <LlmChip name={name} value={String(value)} active={active} onToggle={onToggle} />;
  if (widget === "run") return <RunRefChip name={name} value={String(value)} active={active} onToggle={onToggle} />;
  if (widget === "harness")
    return <HarnessChip name={name} value={value} active={active} onToggle={onToggle} />;

  const { raw, size } = materialize(value, widget);
  const openModal = (e: MouseEvent) => { e.stopPropagation(); setOpen(true); };
  return (
    <>
      <span
        role="button"
        tabIndex={0}
        onClick={onToggle ? (e) => { e.stopPropagation(); onToggle(); } : openModal}
        onKeyDown={(e) => { if (e.key === "Enter") (onToggle ?? (() => setOpen(true)))(); }}
        title={onToggle ? "click to filter; expand icon for full value" : "click for full value"}
        className={chipCls(active)}
      >
        {name !== undefined && <span className="shrink-0 font-mono font-medium">{name}</span>}
        <span className="truncate font-mono text-muted-foreground">{preview(raw)}</span>
        <span className="shrink-0 text-[10px] text-muted-foreground/70">{size}</span>
        <ExpandIcon onClick={openModal} />
      </span>
      {open && (
        <ValueModal title={name ?? "value"} widget={widget} raw={raw} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

const chipCls = (active?: boolean): string =>
  cn(
    "inline-flex max-w-64 cursor-pointer items-center gap-1.5 rounded-md border bg-muted/50 px-2 py-0.5 text-[11px] leading-5",
    active && "border-primary text-primary bg-primary/5",
    "hover:border-primary/60",
  );

function ExpandIcon({ onClick }: { onClick: (e: MouseEvent) => void }) {
  return (
    <button type="button" onClick={onClick} className="shrink-0 rounded p-0.5 hover:bg-accent" aria-label="expand value">
      <Maximize2 className="size-3" />
    </button>
  );
}

/* ---------------- server-descriptor widget (fetch-on-open) ---------------- */

function RefChip({ name, desc, active, onToggle }: {
  name?: string; desc: ParamRef["__param_ref"]; active?: boolean; onToggle?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const openModal = (e: MouseEvent) => { e.stopPropagation(); setOpen(true); };
  return (
    <>
      <span
        role="button"
        tabIndex={0}
        onClick={onToggle ? (e) => { e.stopPropagation(); onToggle(); } : openModal}
        onKeyDown={(e) => { if (e.key === "Enter") (onToggle ?? (() => setOpen(true)))(); }}
        title={onToggle ? "click to filter; expand icon for the full value" : "click for the full value"}
        className={chipCls(active)}
      >
        {name !== undefined && <span className="shrink-0 font-mono font-medium">{name}</span>}
        <span className="truncate font-mono text-muted-foreground">{desc.preview}</span>
        <span className="shrink-0 text-[10px] text-muted-foreground/70">
          {desc.size > 1024 ? `${(desc.size / 1024).toFixed(1)} kB` : `${desc.size} B`}
        </span>
        <ExpandIcon onClick={openModal} />
      </span>
      {open && <RefModal title={name ?? "value"} desc={desc} onClose={() => setOpen(false)} />}
    </>
  );
}

/* fetches the full value on open (cached forever — params are immutable) */
export function RefModal({ title, desc, onClose }: {
  title: string; desc: ParamRef["__param_ref"]; onClose: () => void;
}) {
  const [val, setVal] = useState<unknown>(undefined);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let stop = false;
    fetchParamValue(desc.ref)
      .then((v) => { if (!stop) setVal(v); })
      .catch(() => { if (!stop) setErr(true); });
    return () => { stop = true; };
  }, [desc.ref]);
  if (val === undefined)
    return (
      <ModalShell title={title} badge="loading" copyText="" onClose={onClose}>
        {err
          ? <p className="text-sm text-red-700 dark:text-red-400">failed to fetch the value</p>
          : <LoadingBar />}
      </ModalShell>
    );
  const w = pickWidget(val, undefined, title);
  const widget: ParamWidget = w === "markdown" || w === "json" || w === "text" ? w
    : w === "harness" ? "json" : "text";
  const { raw } = materialize(val, widget);
  return <ValueModal title={title} widget={widget} raw={raw} onClose={onClose} />;
}

/* ---------------- registry-type widgets ---------------- */

/* `llm` — model chip, provider prefix visually separated from the model id */
function LlmChip({ name, value, active, onToggle }: {
  name?: string; value: string; active?: boolean; onToggle?: () => void;
}) {
  const slash = value.indexOf("/");
  const provider = slash > 0 ? value.slice(0, slash) : null;
  const model = slash > 0 ? value.slice(slash + 1) : value;
  const body = (
    <>
      <Sparkles className="size-3 shrink-0 text-violet-600 dark:text-violet-400" />
      {name !== undefined && <span className="shrink-0 font-mono font-medium">{name}</span>}
      <span className="flex min-w-0 items-center font-mono">
        {provider && (
          <span className="rounded-l-sm bg-muted px-1 text-muted-foreground">{provider}</span>
        )}
        <span className={cn("truncate px-1", provider && "rounded-r-sm bg-muted/40")}>{model}</span>
      </span>
    </>
  );
  return onToggle ? (
    <button type="button" className={chipCls(active)} onClick={onToggle} title={value}>{body}</button>
  ) : (
    <span className={chipCls(active)} title={value}>{body}</span>
  );
}

/* `run` — lineage navigation: a run-reference chip linking to the run's page via
   the #/runs/<id> resolver route */
function RunRefChip({ name, value, active, onToggle }: {
  name?: string; value: string; active?: boolean; onToggle?: () => void;
}) {
  const target = findRun(value);
  const go = (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    void navigateWithGlow(
      (e.currentTarget as Element).closest("[data-runref]"),
      `#/runs/${value}`,
      target ? () => prefetchRun(target.condition, value) : undefined,
    );
  };
  const body = (
    <>
      <GitBranch className="size-3 shrink-0 text-primary" />
      {name !== undefined && <span className="shrink-0 font-mono font-medium">{name}</span>}
      <span className="truncate font-mono">…{value.slice(-8)}</span>
    </>
  );
  const title = `run ${value} — open lineage${target ? "" : " (not in local store yet)"}`;
  if (onToggle)
    return (
      <span data-runref role="button" tabIndex={0} className={chipCls(active)} title={title}
        onClick={(e) => { e.stopPropagation(); onToggle(); }}>
        {body}
        <a href={`#/runs/${value}`} onClick={go} className="shrink-0 rounded p-0.5 hover:bg-accent" aria-label="open run">
          <Maximize2 className="size-3" />
        </a>
      </span>
    );
  return (
    <a data-runref href={`#/runs/${value}`} onClick={go} className={cn(chipCls(active), "no-underline")} title={title}>
      {body}
    </a>
  );
}

/* `harness` — compact structured card: id prominent, model, collapsed sections */
function HarnessChip({ name, value, active, onToggle }: {
  name?: string; value: unknown; active?: boolean; onToggle?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const obj = asObject(value);
  const id = String(obj.harness ?? obj.cli ?? obj.kind ?? "harness");
  const model = obj.model ?? obj.llm;
  const openModal = (e: MouseEvent) => { e.stopPropagation(); setOpen(true); };
  return (
    <>
      <span
        role="button"
        tabIndex={0}
        className={chipCls(active)}
        title={onToggle ? "click to filter; expand icon for details" : "click for harness details"}
        onClick={onToggle ? (e) => { e.stopPropagation(); onToggle(); } : openModal}
        onKeyDown={(e) => { if (e.key === "Enter") (onToggle ?? (() => setOpen(true)))(); }}
      >
        <Cpu className="size-3 shrink-0 text-amber-600 dark:text-amber-400" />
        {name !== undefined && <span className="shrink-0 font-mono font-medium">{name}</span>}
        <span className="truncate font-mono font-semibold">{id}</span>
        {model !== undefined && (
          <span className="truncate font-mono text-muted-foreground">{String(model)}</span>
        )}
        <ExpandIcon onClick={openModal} />
      </span>
      {open && (
        <HarnessModal name={name} obj={obj} id={id} model={model} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

/* the harness card modal: structured "rendered" view (settings + model expanded —
   that's what people came to see; env/args stay collapsed) with a rendered | raw
   toggle, raw = the whole value as highlighted JSON */
function HarnessModal({ name, obj, id, model, onClose }: {
  name?: string; obj: Record<string, unknown>; id: string; model: unknown; onClose: () => void;
}) {
  const [mode, setMode] = useState("rendered");
  const raw = JSON.stringify(obj, null, 2);
  return (
    <ModalShell title={name ?? "harness"} badge="harness" copyText={raw} onClose={onClose}>
      <div className="mb-2 flex justify-end">
        <Segmented options={["rendered", "raw"]} value={mode} onChange={setMode} />
      </div>
      {mode === "raw" ? (
        <pre
          className="whitespace-pre-wrap font-mono text-xs [overflow-wrap:anywhere]"
          dangerouslySetInnerHTML={{ __html: highlightJson(raw) }}
        />
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <span className="font-mono text-base font-semibold">{id}</span>
            {model !== undefined && (
              <span className="font-mono text-sm text-muted-foreground">{String(model)}</span>
            )}
          </div>
          <div className="space-y-1 text-sm">
            {Object.entries(obj)
              .filter(([k]) => !["harness", "kind", "cli", "model", "llm"].includes(k))
              .map(([k, v]) =>
                typeof v === "object" && v !== null ? (
                  <Section key={k} k={k} v={v} defaultOpen={k === "settings"} />
                ) : (
                  <div key={k} className="flex gap-2 px-2 font-mono text-xs">
                    <span className="text-muted-foreground">{k}</span>
                    <span>{fmtVal(v)}</span>
                  </div>
                ))}
          </div>
        </>
      )}
    </ModalShell>
  );
}

/* <details> with an initial-open default that user toggling actually overrides */
function Section({ k, v, defaultOpen }: { k: string; v: object; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
      className="rounded-md border"
    >
      <summary className="cursor-pointer px-2 py-1 font-mono text-xs text-muted-foreground">
        {k} · {Array.isArray(v) ? `${v.length} items` : `${Object.keys(v).length} keys`}
      </summary>
      <pre
        className="overflow-x-auto border-t px-2 py-1.5 font-mono text-xs"
        dangerouslySetInnerHTML={{ __html: highlightJson(JSON.stringify(v, null, 2)) }}
      />
    </details>
  );
}

/* ---------------- the modal (hand-rolled: fixed overlay + portal, no new deps) ---------------- */

export function ValueModal({
  title,
  widget,
  raw,
  onClose,
}: {
  title: string;
  widget: ParamWidget;
  raw: string;
  onClose: () => void;
}) {
  let body: ReactNode;
  if (widget === "markdown")
    body = <MdView src={raw} />;
  else if (widget === "json")
    body = (
      <pre
        className="whitespace-pre-wrap font-mono text-xs [overflow-wrap:anywhere]"
        dangerouslySetInnerHTML={{ __html: highlightJson(raw) }}
      />
    );
  else
    body = (
      <pre className="whitespace-pre-wrap font-mono text-xs [overflow-wrap:anywhere]">{raw}</pre>
    );
  return (
    <ModalShell title={title} badge={widget} copyText={raw} onClose={onClose}>
      {body}
    </ModalShell>
  );
}

function ModalShell({
  title,
  badge,
  copyText,
  onClose,
  children,
}: {
  title: string;
  badge: string;
  copyText: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  const copy = () => {
    void navigator.clipboard?.writeText(copyText).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
      onClick={(e) => { e.stopPropagation(); onClose(); }}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-3xl flex-col rounded-xl border bg-background shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b px-4 py-2">
          <span className="truncate font-mono text-sm font-semibold">{title}</span>
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{badge}</span>
          <Button variant="ghost" size="sm" className="ml-auto gap-1.5" onClick={copy}>
            {copied ? <Check className="text-emerald-600" /> : <Copy />}
            {copied ? "copied" : "copy"}
          </Button>
          <Button variant="ghost" size="icon" className="size-7" onClick={onClose} aria-label="close">
            <X />
          </Button>
        </div>
        <div className="overflow-y-auto px-4 py-3">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
