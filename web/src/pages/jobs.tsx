/* Local job queue and history. */

import { useState } from "react";
import { apiPost, JOB_TERMINAL, useJobsPoll, useExecutorPoll } from "@/lib/data";
import { Card } from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { PageLoading, StateBadge } from "@/components/bits";
import { JobPanel } from "@/components/launcher";
import type { JobInfo } from "@/shared/types";

const BTN = "rounded border px-2 py-0.5 text-[11px] hover:bg-muted disabled:opacity-40";

const fmtTs = (iso?: string): string => (iso ?? "").replace("T", " ").slice(0, 19);

export function JobsPage() {
  const jobs = useJobsPoll();
  const executor = useExecutorPoll();
  if (jobs === undefined) return <PageLoading />;
  if (!executor?.enabled) return <p>Jobs are available in adb-local.</p>;
  if (jobs === null) return <p>Unable to read local jobs.</p>;
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">Jobs</h2>
      <p className="text-sm text-muted-foreground">
        {executor?.error ?? (executor?.ready ? "Local execution ready. Jobs run one at a time."
          : "Execution unavailable. Start adb-local to run experiments from this browser.")}
      </p>
      <JobsTable jobs={jobs} enabled={executor?.ready === true} />
    </div>
  );
}

function JobsTable({ jobs, enabled }: { jobs: JobInfo[]; enabled: boolean }) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [err, setErr] = useState<string | null>(null);
  const stop = (id: string) =>
    void apiPost(`/api/jobs/${id}/stop`, {}).catch((e: Error) => setErr(e.message));
  /* the stored spec IS the resubmission — same experiment, sets, profile names,
     replicates; a fresh id, back of the queue */
  const rerun = (j: JobInfo) =>
    void apiPost("/api/jobs", {
      experiment: j.experiment, sets: j.sets, profiles: j.profiles, replicates: j.replicates,
    }).then(() => setErr(null)).catch((e: Error) => setErr(e.message));
  const cols = ["job", "experiment", "state", "runs", "created", ""];
  return (
    <section className="space-y-1.5">
      <h3 className="text-sm font-medium text-muted-foreground">jobs</h3>
      {err && <p className="text-[11px] text-red-600 dark:text-red-400">{err}</p>}
      <Card className="overflow-hidden py-0">
        <Table>
          <TableHeader>
            <TableRow>
              {cols.map((h, i) => <TableHead key={i}>{h}</TableHead>)}
            </TableRow>
          </TableHeader>
          <TableBody>
            {jobs.length === 0 && (
              <TableRow>
                <TableCell colSpan={cols.length} className="text-muted-foreground">
                  nothing queued yet — press ▶ run on an experiment page
                </TableCell>
              </TableRow>
            )}
            {jobs.map((j) => {
              const live = !JOB_TERMINAL.has(j.state);
              const open = expanded[j.id] === true;
              return (
                <JobRows key={j.id} job={j} live={live} open={open} colSpan={cols.length}
                  onToggle={() => setExpanded((e) => ({ ...e, [j.id]: !open }))}
                  enabled={enabled} onStop={() => stop(j.id)} onRerun={() => rerun(j)} />
              );
            })}
          </TableBody>
        </Table>
      </Card>
    </section>
  );
}

/* one job: its table row (click to expand) + the expanded detail row (the same
   JobPanel the builder's run tab shows — log tail, error, run links) */
function JobRows({ job: j, live, open, colSpan, onToggle, onStop, onRerun, enabled }: {
  enabled: boolean; job: JobInfo; live: boolean; open: boolean; colSpan: number;
  onToggle: () => void; onStop: () => void; onRerun: () => void;
}) {
  return (
    <>
      <TableRow className="cursor-pointer" data-job={j.id} onClick={onToggle}>
        <TableCell className="font-mono text-xs">
          <span className="mr-1 inline-block w-2 text-muted-foreground">{open ? "▾" : "▸"}</span>
          {j.id.slice(-6)}
        </TableCell>
        <TableCell className="text-xs">
          <a href={`#/experiments/${encodeURIComponent(j.experiment)}`}
            onClick={(e) => e.stopPropagation()}
            className="underline decoration-dotted">
            {j.experiment}
          </a>
        </TableCell>
        <TableCell><StateBadge state={j.state} /></TableCell>
        <TableCell className="text-xs">
          <span className="flex flex-wrap gap-1.5">
            {j.runs.length === 0 && <span className="text-muted-foreground">—</span>}
            {j.runs.map((rid) => (
              <a key={rid} href={`#/runs/${rid}`} onClick={(e) => e.stopPropagation()}
                className="font-mono underline decoration-dotted">
                {rid.slice(-6)}
              </a>
            ))}
          </span>
        </TableCell>
        <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
          {fmtTs(j.created_at)}
        </TableCell>
        <TableCell className="text-right">
          {live ? (
            <button type="button" disabled={!enabled} className={BTN}
              title="Stop execution; partial run files are kept"
              onClick={(e) => { e.stopPropagation(); onStop(); }}>
              stop
            </button>
          ) : (
            <button type="button" disabled={!enabled} className={BTN}
              title="submit the same spec again (same --sets, profiles, replicates) as a new job"
              onClick={(e) => { e.stopPropagation(); onRerun(); }}>
              re-run
            </button>
          )}
        </TableCell>
      </TableRow>
      {open && (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={colSpan} className="bg-muted/20">
            <div className="max-w-3xl space-y-1.5 py-1">
              <p className="font-mono text-[11px] text-muted-foreground [overflow-wrap:anywhere]">
                {j.sets.length ? j.sets.map((s) => `--set ${s}`).join(" ") : "(no --set args)"}
                {j.replicates > 1 && ` × ${j.replicates} replicates`}
              </p>
              <JobPanel job={j} onStop={onStop} />
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}
