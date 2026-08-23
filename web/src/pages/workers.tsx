/* Workers & queue (#/workers) — manage the launch queue from one place: who can
   run jobs (the worker registry) and everything queued/running/finished (the
   durable job records). Pure viewer over the server's existing surface
   (GET /api/jobs, GET /api/workers, POST /api/jobs/<id>/stop) — re-run needs no
   server support either, because a JobInfo already carries the full secret-free
   spec (sets, profile NAMES, replicates): resubmitting is just POST /api/jobs.
   The same gate as the launch surface applies (loopback, or the bearer token) —
   a refused caller gets a note, not an empty page. */

import { useState } from "react";
import { apiPost, fmtAgo, JOB_TERMINAL, useJobsPoll, useWorkersPoll } from "@/lib/data";
import { Card } from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { PageLoading, PhaseBadge } from "@/components/bits";
import { JobPanel } from "@/components/launcher";
import type { JobInfo, WorkerInfo } from "@/shared/types";

const BTN = "rounded border px-2 py-0.5 text-[11px] hover:bg-muted disabled:opacity-40";

const fmtTs = (iso?: string): string => (iso ?? "").replace("T", " ").slice(0, 19);

export function WorkersPage() {
  const jobs = useJobsPoll();
  const workers = useWorkersPoll();
  if (jobs === undefined || workers === undefined) return <PageLoading />;
  if (jobs === null || workers === null)
    return (
      <div className="space-y-3">
        <h2 className="text-lg font-semibold">Workers</h2>
        <p className="text-sm text-muted-foreground">
          this server refuses the queue surface for this caller — it answers only
          loopback, or remote callers presenting the worker bearer token
          (<code>ADB_WEB_TOKEN</code>). The oneliner on each experiment page always works.
        </p>
      </div>
    );
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">Workers</h2>
      <WorkersTable workers={workers} jobs={jobs} />
      <JobsTable jobs={jobs} />
    </div>
  );
}

function WorkersTable({ workers, jobs }: { workers: WorkerInfo[]; jobs: JobInfo[] }) {
  /* `busy` on the registry can lag a worker's own reports by one claim cycle —
     prefer the job side (a non-terminal job claimed by this worker) */
  const runningFor = (w: WorkerInfo): JobInfo | undefined =>
    jobs.find((j) => !JOB_TERMINAL.has(j.phase) && j.worker?.id === w.id);
  return (
    <section className="space-y-1.5">
      <h3 className="text-sm font-medium text-muted-foreground">workers</h3>
      {workers.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          no worker connected — start one:{" "}
          <code className="rounded bg-muted/60 px-1.5 py-0.5">nix run -f . adb-worker</code>{" "}
          (on this machine or any that can reach this server with the token)
        </p>
      ) : (
        <Card className="overflow-hidden py-0">
          <Table>
            <TableHeader>
              <TableRow>
                {["name", "status", "last seen", "registered"].map((h) => (
                  <TableHead key={h}>{h}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {workers.map((w) => {
                const job = runningFor(w);
                return (
                  <TableRow key={w.id}>
                    <TableCell className="font-mono text-xs">{w.name}</TableCell>
                    <TableCell className="text-xs">
                      {job ? (
                        <span className="text-blue-700 dark:text-blue-400">
                          busy — {job.experiment}{" "}
                          <span className="font-mono text-muted-foreground">{job.id.slice(-6)}</span>
                        </span>
                      ) : (
                        <span className="text-muted-foreground">idle</span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{fmtAgo(w.last_seen)}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {fmtTs(w.registered_at)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Card>
      )}
    </section>
  );
}

function JobsTable({ jobs }: { jobs: JobInfo[] }) {
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
  const cols = ["job", "experiment", "phase", "worker", "runs", "created", ""];
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
              const live = !JOB_TERMINAL.has(j.phase);
              const open = expanded[j.id] === true;
              return (
                <JobRows key={j.id} job={j} live={live} open={open} colSpan={cols.length}
                  onToggle={() => setExpanded((e) => ({ ...e, [j.id]: !open }))}
                  onStop={() => stop(j.id)} onRerun={() => rerun(j)} />
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
function JobRows({ job: j, live, open, colSpan, onToggle, onStop, onRerun }: {
  job: JobInfo; live: boolean; open: boolean; colSpan: number;
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
        <TableCell><PhaseBadge phase={j.phase} /></TableCell>
        <TableCell className="text-xs text-muted-foreground">{j.worker?.name ?? "—"}</TableCell>
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
            <button type="button" className={BTN}
              title="SIGINT, exactly Ctrl-C on the oneliner — partial runs are kept"
              onClick={(e) => { e.stopPropagation(); onStop(); }}>
              stop
            </button>
          ) : (
            <button type="button" className={BTN}
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
