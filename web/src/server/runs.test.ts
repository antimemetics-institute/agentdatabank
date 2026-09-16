import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { readFile, writeFile, rm, readdir, mkdir, rename, utimes, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { copyBadRunCorpus, badRunNames } from "../../test/bad-run-corpus.ts";
import { RunReader } from "./runs.ts";
import { runSummary } from "../lib/run-view.ts";
import { envelope, fixtureCard } from "../../test/event-fixtures.ts";
import { conditionName } from "../lib/identity.ts";

test("record identity resolves suffixed paths, condition params and raw lines before any listing", async () => {
  const root = await copyBadRunCorpus();
  const cid = "a".repeat(40), experiment = "inspect-task-with-hyphens";
  const rid = "20260916t120000z-abcdef012345";
  const dir = join(root, "runs", conditionName(cid, experiment), rid);
  const meta = { condition: cid, experiment, run: rid, state: "completed" };
  const condition = { experiment, source: "source", params: { text: "input" } };
  const line = JSON.stringify({ ...envelope({ type: "log", message: "hello" }), run: rid, experiment }) + "\n";
  try {
    await mkdir(dir, { recursive: true });
    await mkdir(join(root, "conditions"));
    await writeFile(join(root, "conditions", conditionName(cid, experiment) + ".json"), JSON.stringify(condition));
    const card = fixtureCard([JSON.parse(line)]);
    Object.assign(card.identity, { condition: cid });
    card.lifecycle.state = "completed";
    await writeFile(join(dir, "run.json"), JSON.stringify(card));
    await writeFile(join(dir, "events.jsonl"), line);
    const reader = new RunReader(root, () => {});
    const run = await reader.read(cid, rid, true);
    assert.equal(run?.meta.readable, true);
    assert.equal(run?.meta.condition, cid);
    assert.equal(run?.meta.experiment, experiment);
    assert.equal(run?.records?.[0]?.line, line);
    assert.deepEqual(await reader.condition(cid), condition);
    assert.deepEqual(JSON.parse(await reader.raw(cid, rid)), card);
    // A misleading suffix is an error, never an alternative source of identity.
    const wrong = join(root, "runs", conditionName(cid, "another-experiment"));
    await rename(join(root, "runs", conditionName(cid, experiment)), wrong);
    const listing = await reader.list();
    const bad = listing.find((r) => r.run === rid)!;
    assert.equal(bad.experiment, experiment);
    assert.equal(bad.condition, cid);
    assert.equal(bad.readable, false);
    assert.match(bad.reason!, /storage path/);
    assert.deepEqual(JSON.parse(await reader.raw(cid, rid)), card);
  } finally { await rm(root, { recursive: true }); }
});

test("bad-run corpus stays listed; only missing/unparseable run.json is skipped once", async () => {
  const root = await copyBadRunCorpus();
  try {
    assert.deepEqual(await readdir(join(root, "runs/corpus-corpus/20260916t120000z-000000000005")), []);
    const warnings: string[] = [];
    const reader = new RunReader(root, (message) => warnings.push(message));
    const rows = await reader.list();
    assert.deepEqual(rows.map((r) => r.run).sort(), [...badRunNames, "20260916t120000z-000000000000"].sort());
    for (const name of badRunNames) {
      const row = rows.find((r) => r.run === name)!;
      assert.equal(row.readable, false, name);
      assert.ok(row.reason?.length, name);
      assert.ok(!row.reason.includes("\n"));
      assert.equal((await reader.read("corpus", name, true))?.meta.reason, row.reason);
    }
    assert.deepEqual(rows.find((r) => r.run === "20260916t120000z-000000000000")?.summary, { score: 42 });
    assert.equal(rows.find((r) => r.run === "20260916t120000z-000000000000")?.readable, true);
    await reader.list();
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /20260916t120000z-000000000005.*no parseable run.json/);
    // Invalid JSON is the same explicit skip case, still logged only once.
    await writeFile(join(root, "runs/corpus-corpus/20260916t120000z-000000000005/run.json"), "{");
    await reader.list();
    assert.equal(warnings.length, 1);
    // Appending the missing bytes repairs a tail; cached read errors must recover.
    const path = join(root, "runs/corpus-corpus/20260916t120000z-000000000003/events.jsonl");
    const text = await readFile(path, "utf8");
    await writeFile(path, text.slice(0, text.lastIndexOf("\n") + 1));
    assert.equal((await reader.list()).find((r) => r.run === "20260916t120000z-000000000003")?.readable, true);
  } finally { await rm(root, { recursive: true }); }
});

test("liveness comes from card mtime without heartbeat or total event/result counters", async () => {
  const root = await copyBadRunCorpus();
  const rid = "20260916t120000z-000000000000";
  const path = join(root, "runs", "corpus-corpus", rid, "run.json");
  try {
    const card = JSON.parse(await readFile(path, "utf8"));
    card.lifecycle.state = "running";
    assert.ok(!("heartbeat_at" in card.lifecycle));
    assert.ok(!("events" in card.derived.counts));
    assert.ok(!("results" in card.derived.counts));
    const text = JSON.stringify(card);
    await writeFile(path, text);
    const reader = new RunReader(root, () => {});
    for (const timestamp of ["2026-09-16T12:00:00.000Z", "2026-09-16T12:01:00.000Z"]) {
      await utimes(path, new Date(timestamp), new Date(timestamp));
      const read = await reader.read("corpus", rid);
      assert.equal(read?.meta.readable, true);
      assert.equal(read?.meta.heartbeat_at, (await stat(path)).mtime.toISOString());
      assert.equal(read?.meta.heartbeat_at, timestamp);
      assert.equal(await reader.raw("corpus", rid), text);
    }
  } finally { await rm(root, { recursive: true }); }
});

test("summary treats non-array declarations as undeclared", () => {
  const events = [envelope({ type: "result", name: "score", value: 42 })];
  for (const definitions of [undefined, null, {}, { score: {} }, "score", 3])
    assert.deepEqual(runSummary(events, definitions), {});
});

test("HTTP listing and both event endpoints expose identical corpus diagnostics; raw metadata stays verbatim", async () => {
  const root = await copyBadRunCorpus();
  const bundle = join(root, "server.cjs");
  let child: ReturnType<typeof spawn> | undefined;
  try {
    execFileSync(resolve("node_modules/.bin/esbuild"), ["src/server.ts", "--bundle", "--platform=node", "--format=cjs", `--outfile=${bundle}`], { stdio: "pipe" });
    child = spawn(process.execPath, [bundle, "--viewer-only", "--data-dir", root, "--host", "127.0.0.1", "--port", "0", "--no-open"], { stdio: ["ignore", "pipe", "pipe"] });
    let logs = "";
    child.stderr!.on("data", (chunk) => { logs += chunk; });
    const base = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Server did not start")), 10000);
      child!.on("error", reject);
      child!.stdout!.on("data", (chunk) => {
        const match = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/);
        if (match) { clearTimeout(timer); resolve(match[0]); }
      });
    });
    const rows = await (await fetch(base + "/api/runs")).json();
    for (const name of badRunNames) {
      const row = rows.find((r: { run: string }) => r.run === name);
      assert.equal(row.readable, false);
      for (const endpoint of ["events", "events?after=9999", "event/0"]) {
        const response = await fetch(`${base}/api/runs/corpus/${name}/${endpoint}`);
        assert.equal(response.status, 422);
        const body = await response.json();
        assert.equal(body.error, row.reason);
        assert.equal(body.reason, row.reason);
      }
      const raw = await fetch(`${base}/api/runs/corpus/${name}/run.json`);
      assert.deepEqual(Buffer.from(await raw.arrayBuffer()), await readFile(join(root, `runs/corpus-corpus/${name}/run.json`)));
    }
    assert.equal((await fetch(base + "/api/runs/corpus/20260916t120000z-000000000000/events")).status, 200);
    assert.equal((await fetch(base + "/api/runs/corpus/20260916t120000z-000000000000/event/0")).status, 200);
    await fetch(base + "/api/runs");
    assert.equal(logs.split("Skipping corpus-corpus/20260916t120000z-000000000005:").length - 1, 1);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { const closed = once(child, "close"); child.kill("SIGTERM"); await closed; }
    await rm(root, { recursive: true });
  }
});
