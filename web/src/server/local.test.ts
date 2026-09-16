/* Exercise the real server boundary with disposable sources and a protocol stub.
   Python tests separately exercise build/run/process-group supervision. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";

import { fixtureCard } from "../../test/event-fixtures.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T | null>): Promise<T> {
  for (let n = 0; n < 100; n++) {
    try { const result = await fn(); if (result) return result; } catch { /* starting */ }
    await delay(50);
  }
  throw new Error("Timed out waiting for local server");
}

test("managed instances share explicit source/home, bind independently, protect writes and stop cleanly", async () => {
  const dir = mkdtempSync(join(tmpdir(), "adb-local-test-"));
  const children: ChildProcess[] = [];
  try {
    const bundle = join(dir, "server.cjs");
    execFileSync(resolve("node_modules/.bin/esbuild"), ["src/server.ts", "--bundle", "--platform=node", "--format=cjs", `--outfile=${bundle}`], { stdio: "pipe" });
    for (const flags of [
      ["--repo", dir],
      ["--runner", "/missing"],
      ["--executor-python", "/missing"],
      ["--execution-source", dir],
      ["--execution-source", dir, "--execution-source", dir],
    ]) {
      assert.throws(() => execFileSync(process.execPath, [bundle, "--viewer-only", ...flags, "--help"], { stdio: "pipe" }), /read-only/);
    }
    for (const mode of [["--viewer-only"], ["--execution-source", dir, "--runner", "/unused"]]) {
      assert.throws(() => execFileSync(process.execPath, [bundle, ...mode, "--home", dir, "--help"], { stdio: "pipe" }), /Unknown option '--home'/);
      const help = execFileSync(process.execPath, [bundle, ...mode, "--help"], { encoding: "utf8" });
      assert.match(help, /--data-dir DIR/);
      assert.doesNotMatch(help, /--home/);
    }
    const manifests = join(dir, "manifests"); mkdirSync(manifests);
    writeFileSync(join(manifests, "hello.json"), JSON.stringify({ name: "hello", params: {} }));
    const staticDir = join(dir, "static"); mkdirSync(staticDir);
    writeFileSync(join(staticDir, "index.html"), "test frontend");
    const bin = join(dir, "bin"); mkdirSync(bin);
    writeFileSync(join(bin, "nix-build"), `#!/bin/sh\nprintf '%s\\n' "$@" >> "$BUILD_TRACE"\nprintf '%s\\n' "$TEST_MANIFESTS"\n`, { mode: 0o755 });
    const python = join(dir, "python");
    const runner = join(dir, "runner");
    writeFileSync(runner, `#!${process.execPath}
console.log(JSON.stringify({providers: []}));
`, { mode: 0o755 });
    writeFileSync(python, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const endpoint = args[args.indexOf('--server') + 1];
fs.writeFileSync(process.env.ADB_DATA_DIR + '.executor', JSON.stringify({pid: process.pid, args, home: process.env.ADB_DATA_DIR, creds: process.env.ADB_CREDENTIALS_FILE}));
const headers = {'content-type':'application/json', 'x-adb-executor':process.env.ADB_EXECUTOR_CAPABILITY};
let job;
process.on('SIGTERM', async () => {
  if (job) await fetch(endpoint+'/api/jobs/'+job.id+'/done', {method:'POST',headers,body:JSON.stringify({state:'stopped'})});
  process.exit(0);
});
(async () => {
  const r = await fetch(endpoint+'/api/executor/claim', {method:'POST',headers,body:'{}'});
  if (r.status === 200) {
    job = await r.json();
    await fetch(endpoint+'/api/jobs/'+job.id+'/report', {method:'POST',headers,body:JSON.stringify({state:'running'})});
  }
  setInterval(()=>{},1000);
})();
`, { mode: 0o755 });
    async function launch(home: string, port: number, execute = true, explicitDir = true) {
      let output = "";
      const child = spawn(process.execPath, [bundle, "--port", String(port), ...(explicitDir ? ["--data-dir", home] : []), "--no-open",
        "--catalog", manifests, "--static-dir", staticDir, "--host", "127.0.0.1",
        ...(execute ? ["--execution-source", dir, "--runner", runner, "--executor-python", python, "--repo", dir] : ["--viewer-only"])], {
        env: { ...process.env, ADB_LOCAL_SOURCE: "/wrong-source", PATH: `${bin}:${process.env.PATH}`, ADB_RUNNER: "/wrong-runner",
          TEST_MANIFESTS: manifests, BUILD_TRACE: join(dir, "build-trace"),
          ADB_WEB_STATIC: "/wrong-static", ADB_HOST: "invalid-host", ADB_PORT: "invalid-port", ADB_NO_OPEN: "1",
          ADB_WEB_MANIFESTS: join(dir, "wrong-manifests"), ADB_DATA_DIR: explicitDir ? "/wrong-home" : home,
          ADB_HOME: "/obsolete-home",
          ADB_CREDENTIALS_FILE: join(dir, "credentials") },
        stdio: ["ignore", "pipe", "pipe"],
      });
      children.push(child);
      child.stdout!.on("data", (b) => { output += b; });
      child.stderr!.on("data", (b) => { output += b; });
      const url = await until(async () => output.match(/on (http:\/\/[^\s]+)/)?.[1] ?? null);
      if (execute) await until(async () => (await (await fetch(url + "/api/executor")).json()).ready || null);
      return { child, url };
    }
    const a = await launch(join(dir, "a"), 0);
    const b = await launch(join(dir, "b"), Number(new URL(a.url).port), true, false); // env data dir, occupied port
    assert.notEqual(a.url, b.url);
    for (const [instance, home] of [[a, "a"], [b, "b"]] as const) {
      const record = JSON.parse(readFileSync(join(dir, home + ".executor"), "utf8"));
      assert.deepEqual(record.args.slice(0, 2), ["-m", "adb_runner.worker"]);
      assert.equal(record.home, join(dir, home));
      assert.equal(record.args[record.args.indexOf("--server") + 1], instance.url);
      assert.equal(record.args.at(-1), dir);
      assert.equal(record.creds, join(dir, "credentials"));
      assert.deepEqual(await (await fetch(instance.url + "/api/credentials")).json(), { runner: true, providers: [] });
      assert.equal((await (await fetch(instance.url + "/api/experiments")).json())[0].name, "hello");
      assert.equal((await fetch(instance.url + "/api/workers")).status, 404);
      assert.equal((await fetch(instance.url + "/api/executor/claim", { method: "POST" })).status, 403);
      assert.equal((await fetch(instance.url + "/api/jobs", { method: "POST", headers: { origin: "https://other.example" } })).status, 403);
    }
    const spec = { experiment: "hello", sets: ["x=quote' $literal"], profiles: { openai: "work" }, replicates: 2 };
    const submitted = await fetch(a.url + "/api/jobs", { method: "POST", body: JSON.stringify(spec) });
    assert.equal(submitted.status, 201);
    const job = await submitted.json();
    await until(async () => (await (await fetch(a.url + "/api/jobs/" + job.id)).json()).state === "running" || null);
    assert.deepEqual(await (await fetch(b.url + "/api/jobs")).json(), []);
    assert.equal((await fetch(a.url + `/api/jobs/${job.id}/done`, { method: "POST" })).status, 403);
    const closed = once(a.child, "close"); a.child.kill("SIGTERM"); await closed;
    const saved = JSON.parse(readFileSync(join(dir, "a", "jobs", job.id + ".json"), "utf8"));
    assert.equal(saved.state, "stopped");
    assert.deepEqual(saved.sets, spec.sets);
    const bJob = await (await fetch(b.url + "/api/jobs", { method: "POST", body: JSON.stringify(spec) })).json();
    await until(async () => (await (await fetch(b.url + "/api/jobs/" + bJob.id)).json()).state === "running" || null);
    process.kill(JSON.parse(readFileSync(join(dir, "b.executor"), "utf8")).pid, "SIGKILL");
    await until(async () => (await (await fetch(b.url + "/api/executor")).json()).error || null);
    assert.equal((await (await fetch(b.url + "/api/jobs/" + bJob.id)).json()).state, "orphaned");
    assert.equal((await fetch(b.url + "/api/jobs", { method: "POST", body: JSON.stringify(spec) })).status, 503);
    const runDir = join(dir, "read-only", "runs", "condition-hello", "20260916t120000z-012345abcdef");
    mkdirSync(runDir, { recursive: true });
    const definitions = [{ name: "value", type: { kind: "int" }, label: "Recorded value", description: "Explanation. ".repeat(400) }];
    const startRecord = {
      v: 0, ts: "2026-09-16T12:00:00.000000Z", run: "20260916t120000z-012345abcdef", experiment: "hello", schema: 0,
      seq: 0, event: { type: "run.start", condition: "condition", result_definitions: definitions },
    };
    const card = fixtureCard([startRecord]);
    writeFileSync(join(runDir, "run.json"), JSON.stringify(card));
    writeFileSync(join(runDir, "events.jsonl"), JSON.stringify(startRecord) + "\n");
    const readonly = await launch(join(dir, "read-only"), 0, false, false);
    const initial = await fetch(readonly.url + "/api/runs");
    const rows = await initial.json();
    assert.deepEqual(rows[0].result_definitions, definitions);
    const stream = await (await fetch(readonly.url + "/api/runs/condition/20260916t120000z-012345abcdef/events")).json();
    assert.equal(typeof stream[0].event.result_definitions[0].description.__elided.bytes, "number");
    const disk = readFileSync(join(runDir, "events.jsonl"));
    const response = await fetch(readonly.url + "/api/runs/condition/20260916t120000z-012345abcdef/event/0");
    assert.match(response.headers.get("content-type")!, /^text\/plain/);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), disk);
    const rawLine = ' \t{"event":{"type":"custom","kind":"clock","ts":"1999-01-01T00:00:00Z","data":{"unicode":"é\\u0041","n":1e0}},"seq":1,"schema":0,"experiment":"hello","run":"20260916t120000z-012345abcdef","ts":"2026-09-16T12:00:01.000001Z","v":0} \r\n';
    appendFileSync(join(runDir, "events.jsonl"), rawLine);
    const exact = await fetch(readonly.url + "/api/runs/condition/20260916t120000z-012345abcdef/event/1");
    assert.deepEqual(Buffer.from(await exact.arrayBuffer()), Buffer.from(rawLine));
    const captured = await (await fetch(readonly.url + "/api/runs/condition/20260916t120000z-012345abcdef/events?after=0")).json();
    assert.equal(captured[0].ts, "2026-09-16T12:00:01.000001Z");
    assert.equal(captured[0].event.ts, "1999-01-01T00:00:00Z");
    // Stream growth alone does not update results: only the runner writes the card.
    appendFileSync(join(runDir, "events.jsonl"), [
      { type: "result", name: "value", value: 1 },
      { type: "result", name: "unknown", value: 999 },
      { type: "result", name: "value", value: 0 },
      { type: "run.end", state: "completed", duration_s: 5, exit_code: 0 },
    ].map((event, i) => JSON.stringify({ v: 0, ts: "2026-09-16T12:00:05.000000Z",
      run: "20260916t120000z-012345abcdef", experiment: "hello", schema: 0, seq: i + 2, event })).join("\n") + "\n");
    const unchanged = await fetch(readonly.url + "/api/runs", { headers: { "if-none-match": initial.headers.get("etag")! } });
    assert.equal(unchanged.status, 304);
    card.derived.results = { value: 0 };
    card.derived.counts.llm_calls = 23;
    writeFileSync(join(runDir, "run.json"), JSON.stringify(card));
    const updated = await fetch(readonly.url + "/api/runs", { headers: { "if-none-match": initial.headers.get("etag")! } });
    assert.equal(updated.status, 200); // The runner refreshed its card.
    const derived = await updated.json();
    assert.deepEqual(derived[0].summary, { value: 0 });
    assert.equal(derived[0].derived.counts.llm_calls, 23);
    assert.equal((await fetch(readonly.url + "/api/runs", { headers: { "if-none-match": updated.headers.get("etag")! } })).status, 304);
    // A bare payload is not an envelope, even if its seq looks plausible.
    writeFileSync(join(runDir, "events.jsonl"), '{"type":"log","seq":1}\n');
    const invalid = await fetch(readonly.url + "/api/runs/condition/20260916t120000z-012345abcdef/events");
    assert.equal(invalid.status, 422);
    assert.match((await invalid.json()).error, /events.jsonl:1.*Unreadable/);
    assert.equal((await fetch(readonly.url + "/api/runs/condition/20260916t120000z-012345abcdef/event/1")).status, 422);
    assert.equal(await (await fetch(readonly.url + "/")).text(), "test frontend");
    assert.equal((await (await fetch(readonly.url + "/api/experiments")).json())[0].name, "hello");
    assert.equal((await fetch(readonly.url + "/api/jobs", { method: "POST" })).status, 403);
    assert.equal((await fetch(readonly.url + "/api/credentials")).status, 403);
  } finally {
    await Promise.all(children.filter((c) => c.exitCode === null && c.signalCode === null).map(async (c) => {
      const closed = once(c, "close"); c.kill("SIGTERM"); await closed;
    }));
    rmSync(dir, { recursive: true, force: true });
  }
});
