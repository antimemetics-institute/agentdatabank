/* The job queue + worker registry — the server side of `adb-runner worker`.

   The server EXECUTES NOTHING anymore: a job is a durable, secret-free record
   ({experiment, sets, profiles (names), replicates} — the oneliner in structured
   form) that sits `queued` until a worker claims it. Workers are clients: they
   register (name + masked credential inventory), long-poll claim, report progress,
   and finish jobs; the server never reaches into a worker's machine. Locally
   adb-web supervises one worker child so the run button keeps working with zero
   setup — but it speaks this same protocol over loopback, so a second worker on
   another machine (with the bearer token) is the same code path, and pointing the
   worker at a future hosted queue is a URL change.

   Durability: jobs persist to $ADB_HOME/jobs/<id>.json on every transition and
   reload at boot — `queued` ones stay queued (a worker will come), in-flight ones
   reload as `orphaned` but late reports still land (a live worker outrunning a
   server restart flips them back). The worker registry is deliberately ephemeral:
   workers re-register, jobs don't re-happen.

   Zero runtime dependencies, same as server.ts (node stdlib only). */

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JobInfo, WorkerInfo } from "../shared/types";

interface Job extends JobInfo {
  stopRequested?: boolean;
}

interface Worker extends WorkerInfo {
  creds?: unknown; /* masked inventory (list --json shape) — names only, by construction */
}

const jobs = new Map<string, Job>();
const workers = new Map<string, Worker>();
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

function persist(home: string, job: Job): void {
  void mkdir(jobsDir(home), { recursive: true })
    .then(() => writeFile(join(jobsDir(home), `${job.id}.json`), JSON.stringify(jobView(job), null, 2)))
    .catch(() => { /* a failed write loses durability, not the job */ });
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
        job.log.push("adb-web restarted while this job was in flight — if its worker " +
          "survived, its reports will still land here; its runs reach the store either way");
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

/* ---------------- workers ---------------- */

export function registerWorker(name: string, creds: unknown): WorkerInfo {
  const worker: Worker = {
    id: newId("w"), name,
    registered_at: now(), last_seen: now(),
    busy: null,
  };
  worker.creds = creds;
  workers.set(worker.id, worker);
  return { id: worker.id, name: worker.name, registered_at: worker.registered_at, last_seen: worker.last_seen, busy: worker.busy };
}

const WORKER_STALE_MS = 90_000; /* 3+ missed claim holds → presumed gone */

export const listWorkers = (): WorkerInfo[] =>
  [...workers.values()]
    .filter((w) => Date.now() - Date.parse(w.last_seen) < WORKER_STALE_MS)
    .map(({ creds: _creds, ...w }) => w)
    .sort((a, b) => a.registered_at.localeCompare(b.registered_at));

/* ---------------- the queue ---------------- */

interface Waiter {
  workerId: string;
  resolve: (job: Job | null) => void;
}
let waiters: Waiter[] = [];

const nextQueued = (): Job | undefined =>
  [...jobs.values()]
    .filter((j) => j.phase === "queued")
    .sort((a, b) => a.created_at.localeCompare(b.created_at))[0];

function assign(home: string, job: Job, worker: Worker): void {
  job.phase = "claimed";
  job.worker = { id: worker.id, name: worker.name };
  worker.busy = job.id;
  persist(home, job);
}

/* the worker's claim spec: exactly the secret-free job spec, nothing else */
const claimSpec = (job: Job) => ({
  id: job.id, experiment: job.experiment, sets: job.sets,
  profiles: job.profiles, replicates: job.replicates,
});

export function claim(home: string, workerId: string):
  { gone: true } | { job: Promise<ReturnType<typeof claimSpec> | null> } {
  const worker = workers.get(workerId);
  if (!worker) return { gone: true };
  worker.last_seen = now();
  worker.busy = null;
  const ready = nextQueued();
  if (ready) {
    assign(home, ready, worker);
    return { job: Promise.resolve(claimSpec(ready)) };
  }
  return {
    job: new Promise((resolve) => {
      const waiter: Waiter = { workerId, resolve: (j) => resolve(j && claimSpec(j)) };
      waiters.push(waiter);
      setTimeout(() => {
        waiters = waiters.filter((w) => w !== waiter);
        const stillHere = workers.get(workerId);
        if (stillHere) stillHere.last_seen = now();
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
    const worker = workers.get(waiter.workerId);
    if (worker) assign(home, job, worker);
    waiter.resolve(worker ? job : null);
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
  if (job.worker) {
    const worker = workers.get(job.worker.id);
    if (worker) worker.last_seen = now();
  }
  if (body.phase && REPORT_PHASES.has(body.phase as JobInfo["phase"]))
    job.phase = body.phase as JobInfo["phase"]; /* a live report outranks `orphaned` */
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
  if (job.worker) {
    const worker = workers.get(job.worker.id);
    if (worker && worker.busy === job.id) worker.busy = null;
  }
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
