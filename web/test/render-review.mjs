// Usage from web/: node test/render-review.mjs RUN_DIR OUTPUT_DIR MANIFEST_CATALOG
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

if (process.argv.length !== 5) throw new Error("Usage: render-review.mjs RUN_DIR OUTPUT_DIR MANIFEST_CATALOG");
const temporary = mkdtempSync(join(tmpdir(), "adb-stream-review-"));
try {
  const bundle = join(temporary, "review.cjs");
  await build({ entryPoints: ["test/render-review.entry.tsx"], bundle: true,
    platform: "node", format: "cjs", jsx: "automatic", outfile: bundle,
    alias: { "@": resolve("src") }, logLevel: "silent" });
  const result = spawnSync(process.execPath, [bundle, ...process.argv.slice(2)], { stdio: "inherit" });
  process.exitCode = result.status ?? 1;
} finally { rmSync(temporary, { recursive: true, force: true }); }
