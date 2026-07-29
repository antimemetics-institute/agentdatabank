/* Small app-specific atoms shared across pages: phase badge, param chip,
   exit-code badge, inherited-message badge, segmented toggle, markdown view with
   rendered|source toggle, and the run-liveness dot. */
import { useState } from "react";
import type * as React from "react";
import { Badge } from "@/components/ui/badge";
import { fmtVal } from "@/lib/data";
import { md } from "@/lib/markdown";
import { cn } from "@/lib/utils";
import type { Ev, ExtLink } from "@/shared/types";

/* tiny segmented toggle (rendered|source, rendered|raw, …) */
export function Segmented({ options, value, onChange }: {
  options: string[]; value: string; onChange: (v: string) => void;
}) {
  return (
    <span className="inline-flex overflow-hidden rounded-md border text-[11px]">
      {options.map((o) => (
        <button
          key={o}
          type="button"
          onClick={() => onChange(o)}
          className={cn(
            "px-2 py-0.5",
            o === value
              ? "bg-accent font-medium text-accent-foreground"
              : "text-muted-foreground hover:bg-muted/60",
          )}
        >
          {o}
        </button>
      ))}
    </span>
  );
}

/* markdown with a rendered|source toggle (source = escaped monospace). Used by the
   param modal and every markdown-rendering stream payload (gap reports included). */
export function MdView({ src, className }: { src: string; className?: string }) {
  const [mode, setMode] = useState("rendered");
  /* empty content: don't offer a toggle that flips between two blank panes (the
     "toggle does nothing" trap on tool-only model turns) — say it's empty instead */
  if (!src.trim())
    return <span className={cn("text-xs italic text-muted-foreground", className)}>(empty)</span>;
  return (
    <div className={className}>
      <div className="mb-1 flex justify-end">
        <Segmented options={["rendered", "source"]} value={mode} onChange={setMode} />
      </div>
      {mode === "rendered" ? (
        <div className="md text-sm" dangerouslySetInnerHTML={{ __html: md(src) }} />
      ) : (
        <pre className="whitespace-pre-wrap font-mono text-xs [overflow-wrap:anywhere]">{src}</pre>
      )}
    </div>
  );
}

/* run-liveness dot — sits NEXT TO the stream it vouches for. Green pulsing while
   the run's heartbeat is fresh; steady yellow when the heartbeat stopped with
   phase=running (interrupted?); nothing for terminal phases. */
export function LiveDot({ phase }: { phase: string }) {
  if (phase === "running")
    return (
      <span
        className="inline-flex items-center gap-1.5 text-[11px] text-emerald-700 dark:text-emerald-400"
        title="heartbeat fresh — events streaming in, no refresh needed"
      >
        <span className="size-2 animate-pulse rounded-full bg-emerald-500" />
        live
      </span>
    );
  if (phase === "interrupted?")
    return (
      <span
        className="inline-flex items-center gap-1.5 text-[11px] text-amber-700 dark:text-amber-400"
        title="no liveness signal — interrupted?"
      >
        <span className="size-2 rounded-full bg-amber-500" />
        interrupted?
      </span>
    );
  return null;
}

/* the documented convention (run-references.md): a child run re-emits its parent's
   message prefix marked meta.inherited — render it visibly second-hand */
export function InheritedBadge({ ev }: { ev: Ev }) {
  if (!ev.meta?.inherited) return null;
  const from = ev.meta.parent_run
    ? `inherited · ${String(ev.meta.parent_run).slice(-8)}#${fmtVal(ev.meta.parent_seq)}`
    : "inherited";
  return <Badge variant="outline" className="text-[10px] text-muted-foreground">{from}</Badge>;
}

/* "interrupted?" is a DISPLAY phase, not a stored one: a `running` run whose
   heartbeat went stale (lib/data.ts displayPhase, per the events spec) */
export const PHASES =
  ["provisioning", "running", "interrupted?", "completed", "failed", "interrupted"] as const;

const phaseClasses: Record<string, string> = {
  completed: "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  failed: "border-transparent bg-red-500/15 text-red-700 dark:text-red-400",
  interrupted: "border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-400",
  "interrupted?": "border-dashed border-amber-500/60 bg-amber-500/5 text-amber-700 dark:text-amber-400",
  running: "border-transparent bg-blue-500/15 text-blue-700 dark:text-blue-400",
  provisioning: "border-transparent bg-muted text-muted-foreground",
};

const STALE_TIP =
  "no run.end, and the runner's heartbeat (run.json mtime, touched every 10s while alive) went stale — likely crash-orphaned (events spec: Ordering & integrity)";

/* text-only variant for inline use (matrix cells, counts) */
export const phaseText: Record<string, string> = {
  completed: "text-emerald-700 dark:text-emerald-400",
  failed: "text-red-700 dark:text-red-400",
  interrupted: "text-amber-700 dark:text-amber-400",
  "interrupted?": "text-amber-700 dark:text-amber-400",
  running: "text-blue-700 dark:text-blue-400",
  provisioning: "text-muted-foreground",
};

const dotClasses: Record<string, string> = {
  completed: "bg-emerald-500",
  failed: "bg-red-500",
  interrupted: "bg-amber-500",
  "interrupted?": "bg-amber-500/60 ring-1 ring-amber-500",
  running: "bg-blue-500",
  provisioning: "bg-muted-foreground/50",
};

export function PhaseBadge({ phase, className }: { phase: string; className?: string }) {
  return (
    <Badge
      title={phase === "interrupted?" ? STALE_TIP : undefined}
      className={cn(phaseClasses[phase] ?? "bg-muted text-muted-foreground border-transparent", className)}
    >
      {phase === "running" && (
        <span className="size-1.5 animate-pulse rounded-full bg-blue-500" />
      )}
      {phase}
    </Badge>
  );
}

/* tiny colored status dot for dense contexts (matrix cells, inline run refs);
   running pulses to read as alive */
export function PhaseDot({ phase, className }: { phase: string; className?: string }) {
  return (
    <span
      title={phase === "interrupted?" ? STALE_TIP : phase}
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        dotClasses[phase] ?? "bg-muted-foreground/50",
        phase === "running" && "animate-pulse",
        className,
      )}
    />
  );
}

/* ------------- loading affordances (round-3 UX: never flash rendered content) ------------- */

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-md bg-muted", className)} />;
}

/* thin indeterminate bar for the top of a content pane */
export function LoadingBar({ className }: { className?: string }) {
  return (
    <div className={cn("h-0.5 w-full overflow-hidden rounded bg-muted", className)}>
      <div className="adb-loading-bar h-full w-1/3 rounded bg-primary/60" />
    </div>
  );
}

/* first-ever paint only — pages with cached data never show this */
export function PageLoading() {
  return (
    <div className="space-y-3 pt-1">
      <LoadingBar />
      <Skeleton className="h-24" />
      <Skeleton className="h-24" />
      <Skeleton className="h-40" />
    </div>
  );
}

/* monospace key=value chip; clickable when onClick given (param filters) */
export function Chip({
  active,
  onClick,
  className,
  children,
  title,
}: {
  active?: boolean;
  onClick?: () => void;
  className?: string;
  children: React.ReactNode;
  title?: string;
}) {
  const cls = cn(
    "inline-flex items-center rounded-full border bg-muted/50 px-2 py-0 font-mono text-[11px] leading-5 whitespace-nowrap",
    active && "border-primary text-primary bg-primary/5",
    onClick && "cursor-pointer hover:border-primary/60",
    className,
  );
  return onClick ? (
    <button type="button" className={cls} onClick={onClick} title={title}>{children}</button>
  ) : (
    <span className={cls} title={title}>{children}</span>
  );
}

/* the experiment's external references (manifest `links`) as small outbound chips:
   paper / source / dataset ids. Long lists (an eval spanning many datasets) wrap;
   the row stays one visual line of chips, never a section */
export function ExtLinks({ links }: { links?: ExtLink[] }) {
  if (!links?.length) return null;
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {links.map((l) => (
        <a
          key={l.url}
          href={l.url}
          target="_blank"
          rel="noreferrer"
          title={l.url}
          className="inline-flex items-center gap-1 rounded-full border bg-muted/50 px-2 py-0 font-mono text-[11px] leading-5 whitespace-nowrap text-muted-foreground hover:border-primary/60 hover:text-foreground"
        >
          {l.label}
          <span aria-hidden className="text-[9px]">↗</span>
        </a>
      ))}
    </span>
  );
}

export function ExitBadge({ code }: { code: unknown }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 text-[11px] leading-4 whitespace-nowrap",
        code === 0
          ? "border-emerald-500/50 text-emerald-700 dark:text-emerald-400"
          : "border-red-500/50 text-red-700 dark:text-red-400",
      )}
    >
      exit {String(code)}
    </span>
  );
}
