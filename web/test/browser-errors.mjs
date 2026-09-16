/* Optional real-browser guard after pnpm build. No browser dependency in the app.
   From web/: PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs
   CHROMIUM=/path/to/chromium node --experimental-strip-types test/browser-errors.mjs
   With a normal Playwright install, both environment overrides are optional. */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { cp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join, resolve } from "node:path";
import { copyBadRunCorpus, badRunNames } from "./bad-run-corpus.ts";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const root = await copyBadRunCorpus();
let server, browser;
try {
  const staticDir = join(root, "static");
  await cp("dist", staticDir, { recursive: true });
  await build({ entryPoints: ["test/boundary-browser.entry.tsx"], bundle: true, platform: "browser", format: "esm",
    jsx: "automatic", outfile: join(staticDir, "boundary-guard.js"), alias: { "@": resolve("src") } });
  await writeFile(join(staticDir, "boundary-guard.html"), '<!doctype html><div id="root"></div><script type="module" src="/boundary-guard.js"></script>');
  const catalog = join(root, "catalog");
  await mkdir(catalog);
  await writeFile(join(catalog, "corpus.json"), JSON.stringify({ name: "corpus", params: {} }));
  server = spawn(process.execPath, ["dist/server.cjs", "--viewer-only", "--host", "127.0.0.1", "--port", "0",
    "--data-dir", root, "--static-dir", staticDir, "--catalog", catalog, "--no-open"], { stdio: ["ignore", "pipe", "pipe"] });
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Server did not start")), 10000);
    server.on("error", reject);
    server.stdout.on("data", (chunk) => {
      const match = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
  });
  browser = await chromium.launch({ ...(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {}), args: ["--no-sandbox", "--disable-gpu"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const go = (path) => page.goto(base + path);
  await go("/#/runs");
  await page.locator('[data-run="20260916t120000z-000000000000"]').waitFor();
  assert.equal(await page.locator("[data-unreadable-badge]").count(), 4);
  assert.match(await page.locator('[data-run="20260916t120000z-000000000000"]').innerText(), /42/);
  await page.locator('[data-run="20260916t120000z-000000000001"] a').click();
  await page.locator("[data-unreadable-run]").waitFor();
  await go("/#/");
  await page.locator('[data-run="20260916t120000z-000000000001"]').waitFor();
  assert.equal(await page.locator("[data-unreadable-badge]").count(), 4);
  assert.match(await page.locator("main").innerText(), /1 completed/);
  for (const name of badRunNames) {
    for (const tab of ["summary", "stream"]) {
      await go(`/#/run/corpus/${name}?tab=${tab}`);
      await page.locator("[data-unreadable-run]").waitFor();
      await page.waitForFunction((id) => document.querySelector("[data-unreadable-run] h2 code")?.textContent === id, name);
      assert.equal(await page.locator("[data-unreadable-badge]").count(), 1);
      const disclosure = page.locator("[data-raw-run-json]");
      if (!await disclosure.evaluate((node) => node.open)) await disclosure.locator(":scope > summary").click();
      const raw = page.locator("[data-raw-run-json] pre");
      await raw.waitFor();
      assert.equal(await raw.textContent(), await readFile(join(root, `runs/corpus-corpus/${name}/run.json`), "utf8"));
    }
  }
  await go("/#/run/corpus/20260916t120000z-000000000000?tab=summary");
  await page.locator('[data-result-name="score"]').waitFor();
  assert.equal(await page.locator("[data-unreadable-badge]").count(), 0);
  await go("/#/run/corpus/20260916t120000z-000000000000?tab=stream");
  await page.locator("#ev-2").waitFor();
  assert.equal(await page.locator("[data-unreadable-badge]").count(), 0);
  await go("/#/run/corpus/20260916t120000z-000000000005");
  await page.locator("[data-unreadable-run]").waitFor();
  assert.match(await page.locator('[role="alert"]').innerText(), /no parseable run.json/);
  assert.deepEqual(errors, []);

  // SSR cannot exercise React error boundaries; force actual renderer failures.
  await go("/boundary-guard.html");
  await page.locator("#row-boundary [data-unreadable-badge]").waitFor();
  assert.equal(await page.locator("#row-boundary [data-unreadable-badge]").count(), 1);
  assert.match(await page.locator('[data-run="20260916t120000z-000000000007"]').innerText(), /circular/i);
  assert.match(await page.locator('[data-run="20260916t120000z-000000000006"]').innerText(), /42/);
  await page.locator("#page-boundary [data-unreadable-badge]").waitFor();
  assert.equal(await page.locator("#page-boundary [data-unreadable-badge]").count(), 1);
  await page.getByRole("button", { name: "repair fixture" }).click();
  await page.locator("[data-unreadable-badge]").first().waitFor({ state: "detached" });
  assert.equal(await page.locator("[data-unreadable-badge]").count(), 0);
  assert.equal(await page.locator("#row-boundary [data-run]").count(), 2);
  await page.locator('[data-run-tab="summary"]').waitFor();
  assert.deepEqual(errors, []);
  console.log("Browser error guard passed: corpus navigation, raw metadata, one diagnostic per bad run, healthy neighbors, renderer isolation and recovery.");
} finally {
  await browser?.close();
  if (server && server.exitCode === null && server.signalCode === null) { const closed = once(server, "close"); server.kill("SIGTERM"); await closed; }
  await rm(root, { recursive: true, force: true });
}
