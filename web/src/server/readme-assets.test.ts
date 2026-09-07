import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readReadmeAsset } from "./readme-assets.ts";

test("README assets support catalog symlinks but reject traversal and escaped files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "adb-readme-"));
  try {
    await mkdir(join(dir, "catalog/assets"), { recursive: true });
    await mkdir(join(dir, "images"));
    await writeFile(join(dir, "images/overview.svg"), "<svg/>");
    await writeFile(join(dir, "private.svg"), "private");
    await writeFile(join(dir, "images/code.py"), "private");
    await symlink(join(dir, "images"), join(dir, "catalog/assets/govsim"));
    await symlink(join(dir, "private.svg"), join(dir, "images/escape.svg"));
    const catalog = join(dir, "catalog");
    const asset = await readReadmeAsset(catalog, ["govsim", "overview.svg"]);
    assert.equal(asset?.type, "image/svg+xml");
    assert.equal(asset?.body.toString(), "<svg/>");
    for (const path of [
      ["govsim", "..", "private.svg"], ["govsim", "%2e%2e", "private.svg"],
      ["govsim", "%2fprivate.svg"], ["govsim", "escape.svg"],
      ["govsim", "code.py"], ["govsim", "%ZZ"], ["missing", "overview.svg"],
    ]) assert.equal(await readReadmeAsset(catalog, path), null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
