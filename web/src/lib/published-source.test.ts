import assert from "node:assert/strict";
import test from "node:test";
import { PublishedSource, startupSource } from "./published-source.ts";
import { publishedFixture } from "../../test/published-fixture.ts";
import type { RunMeta } from "../shared/types.ts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";

test("published source lists derived values, opens authoritative objects, preserves raw lines and caches runs", async () => {
  const f = await publishedFixture();
  try {
    let now = 1;
    const source = new PublishedSource(f.app, () => now);
    const pending = source.list();
    now = 101; // Response latency must not postpone the next minute's refresh.
    const rows = await pending;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.readable, true);
    const params = rows[0]!.params as Record<string, unknown>;
    const descriptor = params.long as { __param_ref: { ref: string; size: number; hash: string } };
    assert.equal(descriptor.__param_ref.size, f.long.length);
    assert.equal(descriptor.__param_ref.hash.length, 64);
    assert.equal(f.store.requests.length, 0);
    const api = `/api/runs/condition/${f.card.identity.run}`;
    assert.deepEqual(await source.json(`/api/runs/${descriptor.__param_ref.ref}`), { value: f.long });
    assert.equal(await source.text(api + "/run.json"), f.raw);
    assert.equal((await source.json(api + "/events?after=-1") as unknown[]).length, 3);
    assert.equal(await source.text(api + "/event/1"), f.lines[1]);
    assert.deepEqual(await source.json(api + "/schemas"), [{ title: "shared" }, { title: "specific" }]);
    const requests = f.store.requests.length;
    await source.json(api + "/events?after=1");
    await source.text(api + "/run.json");
    await source.text(api + "/event/1");
    assert.equal(f.store.requests.length, requests);
    const indexRequests = f.site.requests.length;
    now = 60_000;
    await source.list();
    assert.equal(f.site.requests.length, indexRequests);
    now += 1;
    await Promise.all([source.list(), source.list()]);
    assert.equal(f.site.requests.length, indexRequests + 2);
    assert.ok(f.site.requests.slice(-2).every((request) => request.status === 304 && request.headers["if-none-match"]));
    const added = structuredClone(f.card);
    added.identity.run = "20260918t120000z-000000000003";
    f.site.files.set(f.indexPath + "experiments/example/index.jsonl", [f.row, { ...f.row, card: added }].map((row) => JSON.stringify(row)).join("\n"));
    now += 60_000;
    assert.equal((await source.list()).length, 2);
    assert.equal(f.site.requests.at(-1)!.status, 200);
    assert.ok(f.site.requests.at(-1)!.headers["if-none-match"]);
    for (const request of [...f.site.requests, ...f.store.requests]) {
      assert.equal(request.headers.authorization, undefined);
      assert.equal(request.headers.cookie, undefined);
    }
  } finally { await f.close(); }
});

test("damaged rows and missing shards are diagnostic entries with healthy neighbors", async () => {
  const f = await publishedFixture();
  try {
    const bad = structuredClone(f.card);
    bad.identity.run = "20260918t120000z-000000000002";
    bad.derived.counts.llm_calls = -1;
    f.site.files.set(f.indexPath + "experiments/example/index.jsonl", ["{", JSON.stringify({ store: f.row.store, card: bad }), JSON.stringify(f.row)].join("\n"));
    f.site.files.set(f.indexPath + "index.json", JSON.stringify({ v: 0, experiments: [{ name: "missing", runs: 9 }, { name: "example", runs: 3 }] }));
    const source = new PublishedSource(f.app);
    const rows = await source.list();
    assert.equal(rows.length, 4);
    assert.equal(rows.filter((row) => row.readable).length, 1);
    assert.equal(rows.filter((row) => row.experiment === "missing").length, 1);
    assert.ok(rows.filter((row) => !row.readable).every((row) => row.reason));
    assert.match(rows.find((row) => row.experiment === "missing")!.reason!, /HTTP 404/);
  } finally { await f.close(); }
});

test("run objects follow redirects to signed URLs on another host without credentials", async () => {
  const f = await publishedFixture(true);
  try {
    const source = new PublishedSource(f.app);
    const api = `/api/runs/condition/${f.card.identity.run}`;
    assert.equal(await source.text(api + "/run.json"), f.raw);
    assert.equal(await source.text(api + "/event/1"), f.lines[1]);
    assert.notEqual(new URL(f.cdn.origin).hostname, new URL(f.store.origin).hostname);
    assert.equal(f.store.requests.length, 2);
    assert.ok(f.store.requests.every((request) => request.status === 302));
    assert.equal(f.cdn.requests.length, 2);
    assert.ok(f.cdn.requests.every((request) => request.status === 200 && request.url.includes("X-Amz-Signature=fixture-signature")));
    await source.text(api + "/run.json");
    await source.text(api + "/event/1");
    assert.equal(f.store.requests.length, 2);
    assert.equal(f.cdn.requests.length, 2);
    for (const request of [...f.site.requests, ...f.store.requests, ...f.cdn.requests]) {
      assert.equal(request.headers.authorization, undefined);
      assert.equal(request.headers.cookie, undefined);
    }
  } finally { await f.close(); }
});

test("object identity mismatch becomes a diagnostic, and raw card comes from the store", async () => {
  const f = await publishedFixture();
  try {
    const wrong = structuredClone(f.card);
    wrong.identity.condition = "different";
    const raw = JSON.stringify(wrong, null, 3) + "\n";
    f.store.files.set(f.stem + "/run.json", raw);
    const source = new PublishedSource(f.app);
    const api = `/api/runs/condition/${f.card.identity.run}`;
    await assert.rejects(source.json(api + "/events"), /identity disagrees with its object path/);
    const [row] = await source.list();
    assert.equal(row!.readable, false);
    assert.match(row!.reason!, /identity disagrees/);
    assert.equal(await source.text(api + "/run.json"), raw);
    assert.equal(f.store.requests.filter((r) => r.path.endsWith(".zst")).length, 0);
  } finally { await f.close(); }
});

test("startup reads the index beside the app, at the root or under a path prefix", async () => {
  for (const appPath of ["/", "/prefix/adb/"]) {
    const f = await publishedFixture(false, appPath);
    try {
      assert.equal((await startupSource(f.app)).mode, "local");
      f.site.files.set(appPath + "site.json", JSON.stringify({ v: 0 }));
      for (const page of [f.app, f.app + "index.html?view=runs#/runs"]) {
        const source = await startupSource(page);
        assert.equal(source.mode, "published");
        assert.equal(source.pollMs, 60_000);
        const rows = await source.json("/api/runs") as RunMeta[];
        assert.equal(rows.length, 1);
        assert.equal(rows[0]!.readable, true);
        assert.equal(rows[0]!.run, f.card.identity.run);
        assert.equal(source.asset("catalog/assets/example/figure.svg"), f.app + "catalog/assets/example/figure.svg");
        assert.equal((await source.json("/api/experiments") as unknown[]).length, 1);
        await assert.rejects(source.post("/api/jobs", {}), /unavailable/);
        await assert.rejects(source.json("/api/credentials"), /unavailable/);
      }
      assert.ok(f.site.requests.some((request) => request.path === appPath + "index/index.json"));
      assert.ok(f.site.requests.some((request) => request.path === appPath + "index/experiments/example/index.jsonl"));
      assert.ok(f.site.requests.every((request) => request.path.startsWith(appPath) && !request.path.includes("/api/")));
    } finally { await f.close(); }
  }
});

test("site.json rejects unknown keys and unsupported versions before loading the index", async () => {
  const f = await publishedFixture();
  try {
    for (const config of [null, [], {}, { v: 1 }, { v: "0" }, { v: 0, index_url: "index/" }, { v: 0, extra: true }]) {
      f.site.files.set(f.appPath + "site.json", JSON.stringify(config));
      await assert.rejects(startupSource(f.app), /Invalid site.json/);
    }
    assert.ok(f.site.requests.every((request) => request.path === f.appPath + "site.json"));
    assert.equal(f.store.requests.length, 0);
  } finally { await f.close(); }
});

test("bundled hints fall back to shared hints for an unknown schema version", async () => {
  const f = await publishedFixture();
  try {
    const card = structuredClone(f.card);
    card.identity.schema = 99;
    f.site.files.set(f.indexPath + "experiments/example/index.jsonl", JSON.stringify({ ...f.row, card }) + "\n");
    f.store.files.set(f.stem + "/run.json", JSON.stringify(card));
    const source = new PublishedSource(f.app);
    assert.deepEqual(await source.json(`/api/runs/condition/${card.identity.run}/schemas`), [{ title: "shared" }]);
  } finally { await f.close(); }
});

test("local Vite development keeps working when site.json is absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "adb-site-config-"));
  await writeFile(join(root, "index.html"), "<html><body>Local app</body></html>");
  const vite = await createServer({ configFile: false, root, logLevel: "silent", server: { host: "127.0.0.1", port: 0 } });
  try {
    await vite.listen();
    const site = vite.resolvedUrls!.local[0]!;
    assert.match(await (await fetch(new URL("site.json", site))).text(), /Local app/);
    assert.equal((await startupSource(site)).mode, "local");
  } finally { await vite.close(); await rm(root, { recursive: true, force: true }); }
});
