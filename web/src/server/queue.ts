/* Bounded FIFO for the single local executor. In-flight jobs never replay on restart. */

import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JobInfo } from "../shared/types";

interface Job extends JobInfo {
  stopRequested?: boolean;
}

const jobs = new Map<string, Job>();
const TERMINAL = new Set<JobInfo["phase"]>(["completed", "failed", "stopped", "orphaned", "error"]);
const LOG_CAP = 400;      /* narration tail lines kept per job */
const QUEUE_CAP = 32;     /* refuse a deeper backlog — runaway guard, not a scheduler */
export const CLAIM_HOLD_MS = 25_000;

const now = (): string => new Date().toISOString();
const newId = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 36 ** 4).toString(36).padStart(4, "0")}`;

export function jobView(job: Job): JobInfo {
  const { stopRequested: _stop, ...view } = job;
  return view;
}

const jobsDir = (home: string): string => join(home, "jobs");

let writes = Promise.resolve();
function persist(home: string, job: Job): void {
  const snapshot = JSON.stringify(jobView(job), null, 2);
  writes = writes.then(async () => {
    await mkdir(jobsDir(home), { recursive: true });
    const path = join(jobsDir(home), `${job.id}.json`);
    await writeFile(`${path}.tmp`, snapshot);
    await rename(`${path}.tmp`, path);
  }).catch((err) => console.error("job persistence failed:", err));
}
export const flushJobs = (): Promise<void> => writes;

export function interruptJobs(home: string): void {
  for (const job of jobs.values()) {
    if (!TERMINAL.has(job.phase) && job.phase !== "queued") {
      job.phase = "orphaned";
      job.finished_at = now();
      job.log.push("Local executor exited; this job will not be retried automatically.");
      persist(home, job);
    }
  }
}

function pushLog(home: string, job: Job, lines: string[]): void {
  job.log.push(...lines);
  if (job.log.length > LOG_CAP) job.log.splice(0, job.log.length - LOG_CAP);
  persist(home, job);
}

export async function initJobs(home: string): Promise<void> {
  let files: string[] = [];
  try { files = (await readdir(jobsDir(home))).filter((f) => f.endsWith(".json")); }
  catch { return; }
  for (const f of files) {
    try {
      const job = JSON.parse(await readFile(join(jobsDir(home), f), "utf8")) as Job;
      if (!TERMINAL.has(job.phase) && job.phase !== "queued") {
        job.phase = "orphaned";
        job.log.push("Local ADB restarted during this job; it will not be retried automatically.");
        persist(home, job);
      }
      jobs.set(job.id, job);
    } catch { /* foreign/half-written file — skip */ }
  }
}

export const listJobs = (): JobInfo[] =>
  [...jobs.values()].map(jobView)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));

export const getJob = (id: string): JobInfo | null => {
  const job = jobs.get(id);
  return job ? jobView(job) : null;
};

/* ---------------- the queue ---------------- */

interface Waiter {
  resolve: (job: Job | null) => void;
}
let waiters: Waiter[] = [];

const nextQueued = (): Job | undefined =>
  [...jobs.values()]
    .filter((j) => j.phase === "queued")
    .sort((a, b) => a.created_at.localeCompare(b.created_at))[0];

function assign(home: string, job: Job): void {
  job.phase = "claimed";
  persist(home, job);
}

/* the worker's claim spec: exactly the secret-free job spec, nothing else */
const claimSpec = (job: Job) => ({
  id: job.id, experiment: job.experiment, sets: job.sets,
  profiles: job.profiles, replicates: job.replicates,
});

export function claim(home: string): { job: Promise<ReturnType<typeof claimSpec> | null> } {
  // One supervised executor, one in-flight job. Duplicate claims cannot start another.
  if ([...jobs.values()].some((j) => !TERMINAL.has(j.phase) && j.phase !== "queued"))
    return { job: Promise.resolve(null) };
  const ready = nextQueued();
  if (ready) {
    assign(home, ready);
    return { job: Promise.resolve(claimSpec(ready)) };
  }
  return {
    job: new Promise((resolve) => {
      const waiter: Waiter = { resolve: (j) => resolve(j && claimSpec(j)) };
      waiters.push(waiter);
      setTimeout(() => {
        waiters = waiters.filter((w) => w !== waiter);
        waiter.resolve(null);
      }, CLAIM_HOLD_MS).unref?.();
    }),
  };
}

export interface JobSpec {
  experiment: string;
  sets: string[];
  profiles: Record<string, string>;
  replicates: number;
}

export function submit(home: string, spec: JobSpec): { job: JobInfo } | { error: string } {
  const backlog = [...jobs.values()].filter((j) => !TERMINAL.has(j.phase)).length;
  if (backlog >= QUEUE_CAP)
    return { error: `${QUEUE_CAP} jobs already queued or running — wait or stop some` };
  const job: Job = {
    id: newId("j"),
    experiment: spec.experiment,
    phase: "queued",
    sets: spec.sets,
    profiles: spec.profiles,
    replicates: spec.replicates,
    created_at: now(),
    runs: [],
    log: [],
  };
  jobs.set(job.id, job);
  persist(home, job);
  const waiter = waiters.shift();
  if (waiter) {
    assign(home, job);
    waiter.resolve(job);
  }
  return { job: jobView(job) };
}

/* ---------------- worker reports (the command channel rides the reply) ---------------- */

const REPORT_PHASES = new Set<JobInfo["phase"]>(["building", "running"]);

export function report(
  home: string, id: string,
  body: { phase?: string; runs?: string[]; log?: string[] },
): { stop: boolean } | null {
  const job = jobs.get(id);
  if (!job) return null;
  if (TERMINAL.has(job.phase)) return { stop: true };
  if (body.phase && REPORT_PHASES.has(body.phase as JobInfo["phase"]))
    job.phase = body.phase as JobInfo["phase"];
  for (const rid of body.runs ?? [])
    if (!job.runs.includes(rid)) job.runs.push(rid);
  if (body.log?.length) pushLog(home, job, body.log);
  else persist(home, job);
  return { stop: job.stopRequested === true };
}

const DONE_PHASES = new Set<JobInfo["phase"]>(["completed", "failed", "stopped", "error"]);

export function done(
  home: string, id: string,
  body: { phase?: string; exit_code?: number },
): boolean {
  const job = jobs.get(id);
  if (!job) return false;
  job.phase = DONE_PHASES.has(body.phase as JobInfo["phase"])
    ? (body.phase as JobInfo["phase"]) : "failed";
  if (typeof body.exit_code === "number") job.exit_code = body.exit_code;
  job.finished_at = now();
  persist(home, job);
  return true;
}

/* stop: a queued job dies immediately; an in-flight one gets the flag, delivered
   on the worker's next report (its cadence bounds the latency to ~1s) */
export function stopJob(home: string, id: string): boolean {
  const job = jobs.get(id);
  if (!job || TERMINAL.has(job.phase)) return false;
  if (job.phase === "queued") {
    job.phase = "stopped";
    job.finished_at = now();
    persist(home, job);
    return true;
  }
  job.stopRequested = true;
  return true;
}
