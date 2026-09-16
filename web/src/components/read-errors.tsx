/* A corrupt run or a renderer defect must not take its neighbors off screen. */
import { Component, useEffect, useState, type ReactNode } from "react";
import { fetchRunJson } from "@/lib/data";
import { metadataReason, object, oneLineReason } from "@/lib/run-readability";
import type { RunMeta } from "@/shared/types";

export class RenderBoundary extends Component<{
  children: ReactNode; fallback: (reason: string) => ReactNode; resetKey?: unknown;
}, { reason: string | null }> {
  state = { reason: null as string | null };
  static getDerivedStateFromError(error: unknown) { return { reason: oneLineReason(error) }; }
  componentDidUpdate(previous: Readonly<{ resetKey?: unknown }>) {
    if (this.state.reason && previous.resetKey !== this.props.resetKey) this.setState({ reason: null });
  }
  render() { return this.state.reason ? this.props.fallback(this.state.reason) : this.props.children; }
}

/** Safe navigation identity for damaged metadata; nothing is written back. */
export function displayRun(value: unknown, index = 0): RunMeta {
  const row = object(value) ? value : {};
  const reason = row.readable === false ? oneLineReason(row.reason ?? "Run could not be read") : metadataReason(value);
  return { ...row, run: typeof row.run === "string" ? row.run : `unknown-run-${index}`,
    condition: typeof row.condition === "string" ? row.condition : "unknown-condition",
    experiment: typeof row.experiment === "string" ? row.experiment : "unknown",
    ...(reason ? { readable: false, reason } : {}) } as RunMeta;
}

export function UnreadableBadge() {
  return <span data-unreadable-badge="" className="rounded border border-amber-500/50 bg-amber-500/10 px-1.5 py-0.5 text-xs text-amber-800 dark:text-amber-300">unreadable</span>;
}

export function UnreadableRunLink({ run, reason }: { run: RunMeta; reason: string }) {
  return <a data-run={run.run} href={`#/run/${encodeURIComponent(run.condition)}/${encodeURIComponent(run.run)}`}
    className="block space-y-1 rounded border p-2 text-xs hover:bg-muted/40">
    <span className="flex items-center gap-2"><UnreadableBadge /><code>{run.run}</code></span>
    <span className="block text-muted-foreground">{reason}</span>
  </a>;
}

export function UnreadableRunPanel({ cid, rid, reason, rawRunJson }: {
  cid: string; rid: string; reason: string; rawRunJson?: string | null;
}) {
  const [raw, setRaw] = useState<string | null>(rawRunJson ?? null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (rawRunJson !== undefined) { setRaw(rawRunJson); return; }
    let active = true;
    void fetchRunJson(cid, rid).then((text) => { if (active) setRaw(text); })
      .catch((error) => { if (active) setError(oneLineReason(error)); });
    return () => { active = false; };
  }, [cid, rid, rawRunJson]);
  return <section data-unreadable-run="" className="max-h-full space-y-3 overflow-auto rounded border p-4">
    <h2 className="flex flex-wrap items-center gap-2 text-base"><UnreadableBadge /><code>{rid}</code></h2>
    <p role="alert" className="text-sm">{oneLineReason(reason)}</p>
    <details data-raw-run-json="">
      <summary className="cursor-pointer text-xs text-muted-foreground">raw run.json</summary>
      {raw !== null ? <pre className="mt-2 overflow-auto whitespace-pre-wrap font-mono text-xs">{raw}</pre>
        : <p className="mt-2 text-sm text-muted-foreground">{error ?? (rawRunJson === null ? "No run.json recorded." : "Loading run.json…")}</p>}
    </details>
  </section>;
}
