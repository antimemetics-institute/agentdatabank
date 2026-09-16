import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { reviewOutputDirectory } from "./review-output.ts";

test("review output is explicit and outside any run, including symlink aliases", () => {
  const root = mkdtempSync(join(tmpdir(), "adb-review-path-"));
  try {
    const run = join(root, "runs/c/run"), other = join(root, "runs/c/other");
    for (const path of [run, other]) { mkdirSync(path, { recursive: true }); writeFileSync(join(path, "run.json"), "{}"); }
    const alias = join(root, "alias");
    symlinkSync(run, alias);
    for (const path of [run, join(run, "review"), join(run, "workspace/review"),
      join(other, "review"), join(alias, "new/review")])
      assert.throws(() => reviewOutputDirectory(run, path), /outside recorded runs/);
    assert.throws(() => reviewOutputDirectory(run, ""), /required/);
    const output = join(root, "reviews/new/dump");
    assert.equal(reviewOutputDirectory(run, output), output);
    assert.equal(existsSync(output), false);
    symlinkSync(join(run, "not-created"), join(root, "dangling"));
    assert.throws(() => reviewOutputDirectory(run, join(root, "dangling/review")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
