/* Local FIFO transitions, durable records, and restart behavior. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claim, done, getJob, initJobs, flushJobs, report, stopJob, submit,
} from "./queue.ts";

const home = mkdtempSync(join(tmpdir(), "adb-queue-"));
const SPEC = { experiment: "hello", sets: ["x=1"], profiles: { openai: "work" },
  replicates: 2 };

test("submit → claim → report → stop-via-report → done, durably", async () => {
  const sub = submit(home, SPEC);
  assert.ok("job" in sub);
  const id = sub.job.id;
  assert.equal(sub.job.phase, "queued");

  const c = claim(home);
  assert.ok(!("gone" in c));
  const spec = await (c as {
    job: Promise<{ id: string; sets: string[] } | null>;
  }).job;
  assert.ok(spec);
  assert.equal(spec.id, id);
  assert.deepEqual(spec.sets, ["x=1"]); /* the spec passes through verbatim */
  assert.equal(getJob(id)!.phase, "claimed");

  assert.deepEqual(report(home, id, { phase: "running", runs: ["R1"], log: ["hi"] }),
    { stop: false });
  assert.equal(getJob(id)!.phase, "running");
  stopJob(home, id);
  assert.deepEqual(report(home, id, {}), { stop: true }); /* the reply IS the command channel */
  assert.ok(done(home, id, { phase: "stopped", exit_code: 130 }));
  const j = getJob(id)!;
  assert.equal(j.phase, "stopped");
  assert.equal(j.exit_code, 130);
  assert.deepEqual(j.runs, ["R1"]);
  /* durable: the disk record survives this process (persist is fire-and-forget,
     so give the write a beat to land) */
  await flushJobs();
  const disk = JSON.parse(readFileSync(join(home, "jobs", `${id}.json`), "utf8"));
  assert.equal(disk.phase, "stopped");
  assert.ok(!("stopRequested" in disk)); /* server-private state never persists */
});

test("a queued job stops immediately", () => {
  const sub = submit(home, SPEC);
  assert.ok("job" in sub);
  assert.ok(stopJob(home, sub.job.id));
  assert.equal(getJob(sub.job.id)!.phase, "stopped");
});

test("boot: in-flight jobs orphan and cannot revive, queued jobs survive", async () => {
  const home2 = mkdtempSync(join(tmpdir(), "adb-queue-boot-"));
  mkdirSync(join(home2, "jobs"), { recursive: true });
  const base = { experiment: "hello", sets: [], profiles: {}, replicates: 1, created_at: "t", runs: [], log: [] };
  writeFileSync(join(home2, "jobs", "j-flight.json"),
    JSON.stringify({ ...base, id: "j-flight", phase: "running" }));
  writeFileSync(join(home2, "jobs", "j-waiting.json"),
    JSON.stringify({ ...base, id: "j-waiting", phase: "queued" }));
  await initJobs(home2);
  assert.equal(getJob("j-flight")!.phase, "orphaned");
  assert.equal(getJob("j-waiting")!.phase, "queued");
  /* Late reports cannot revive an orphaned execution. */
  assert.deepEqual(report(home2, "j-flight", { phase: "running" }), { stop: true });
  assert.equal(getJob("j-flight")!.phase, "orphaned");
});
