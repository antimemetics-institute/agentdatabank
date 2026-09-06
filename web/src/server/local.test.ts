/* Exercise the real server boundary with disposable sources and a protocol stub.
   Python tests separately exercise build/run/process-group supervision. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";

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
  if (job) await fetch(endpoint+'/api/jobs/'+job.id+'/done', {method:'POST',headers,body:JSON.stringify({phase:'stopped'})});
  process.exit(0);
});
(async () => {
  const r = await fetch(endpoint+'/api/executor/claim', {method:'POST',headers,body:'{}'});
  if (r.status === 200) {
    job = await r.json();
    await fetch(endpoint+'/api/jobs/'+job.id+'/report', {method:'POST',headers,body:JSON.stringify({phase:'running'})});
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
    await until(async () => (await (await fetch(a.url + "/api/jobs/" + job.id)).json()).phase === "running" || null);
    assert.deepEqual(await (await fetch(b.url + "/api/jobs")).json(), []);
    assert.equal((await fetch(a.url + `/api/jobs/${job.id}/done`, { method: "POST" })).status, 403);
    const closed = once(a.child, "close"); a.child.kill("SIGTERM"); await closed;
    const saved = JSON.parse(readFileSync(join(dir, "a", "jobs", job.id + ".json"), "utf8"));
    assert.equal(saved.phase, "stopped");
    assert.deepEqual(saved.sets, spec.sets);
    const bJob = await (await fetch(b.url + "/api/jobs", { method: "POST", body: JSON.stringify(spec) })).json();
    await until(async () => (await (await fetch(b.url + "/api/jobs/" + bJob.id)).json()).phase === "running" || null);
    process.kill(JSON.parse(readFileSync(join(dir, "b.executor"), "utf8")).pid, "SIGKILL");
    await until(async () => (await (await fetch(b.url + "/api/executor")).json()).error || null);
    assert.equal((await (await fetch(b.url + "/api/jobs/" + bJob.id)).json()).phase, "orphaned");
    assert.equal((await fetch(b.url + "/api/jobs", { method: "POST", body: JSON.stringify(spec) })).status, 503);
    const readonly = await launch(join(dir, "read-only"), 0, false, false);
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
