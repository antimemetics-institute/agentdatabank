import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readRunSchemas } from "./event-schemas.ts";

test("schemas come only from the current catalog's matching experiment and version", async () => {
  const root = await mkdtemp(join(tmpdir(), "adb-schemas-"));
  try {
    const run = join(root, "run"); const catalog = join(root, "catalog");
    await Promise.all([mkdir(run), mkdir(catalog)]);
    await Promise.all([writeFile(join(catalog, "schema.json"), '{"title":"experiment"}'),
      writeFile(join(catalog, "shared-schema.json"), '{"title":"shared"}')]);
    const manifests = [{ name: "test", params: {}, schema: { version: 0, models: "test:Payload", path: join(catalog, "schema.json") } }];
    assert.deepEqual(await readRunSchemas(manifests, "test", 0), [{ title: "shared" }, { title: "experiment" }]);
    assert.deepEqual(await readRunSchemas(manifests, "test", 1), [{ title: "shared" }]);
    assert.deepEqual(await readRunSchemas(manifests, "other", 0), [{ title: "shared" }]);
    await Promise.all([writeFile(join(run, "schema.json"), '{"title":"saved"}'),
      writeFile(join(run, "shared-schema.json"), '{"title":"saved shared"}')]);
    assert.deepEqual(await readRunSchemas(manifests, "test", 0), [{ title: "shared" }, { title: "experiment" }]);
    assert.deepEqual(await readRunSchemas([], "test", 0), []);
  } finally { await rm(root, { recursive: true }); }
});
