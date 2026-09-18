import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { awsProfiles } from "./aws-profiles.ts";

test("profile discovery returns names only and never creates or rewrites AWS files", async () => {
  const root = await mkdtemp(join(tmpdir(), "adb-aws-profiles-"));
  const path = join(root, "config");
  const content = "[default]\nregion = us-east-1\n[profile research team]\naws_secret_access_key = never-return-this\n[services provider]\n[profile hf]\n";
  try {
    await writeFile(path, content);
    assert.deepEqual(await awsProfiles(path), ["default", "hf", "research team"]);
    assert.equal(await readFile(path, "utf8"), content);
    assert.deepEqual(await awsProfiles(join(root, "absent", "config")), []);
    assert.deepEqual(await readdir(root), ["config"]);
  } finally { await rm(root, { recursive: true }); }
});
