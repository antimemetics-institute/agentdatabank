/* Build & run the render guard (test/render-guard.entry.tsx): esbuild-bundle the
   real components for node, execute, propagate the exit code. Part of `pnpm test`. */

import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(mkdtempSync(join(tmpdir(), "adb-render-guard-")), "guard.cjs");

await build({
  entryPoints: [join(here, "render-guard.entry.tsx")],
  bundle: true,
  platform: "node",
  format: "cjs",
  jsx: "automatic",
  outfile: out,
  alias: { "@": join(here, "..", "src") },
  logLevel: "silent",
  // Browser-only charts are loaded in an effect, never by the SSR guard.
  external: ["vega-embed"],
  plugins: [{ name: "empty-narratives", setup(build) {
    build.onResolve({ filter: /^virtual:experiment-(pages|thumbnails)$/ }, () => ({ path: "pages", namespace: "narratives" }));
    build.onLoad({ filter: /.*/, namespace: "narratives" }, () => ({ contents: "export default {}" }));
  } }],
});

const res = spawnSync(process.execPath, [out], {
  stdio: "inherit",
  env: { ...process.env, FIXTURE: join(here, "fixtures", "govsim-mock-events.jsonl") },
});
process.exit(res.status ?? 1);
