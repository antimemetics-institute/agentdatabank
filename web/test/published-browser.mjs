/* Real static-bundle network guard. Requires the same optional browser tools as browser-errors.mjs.
   WEB_DIST=/nix/store/...-adb-web-dist-... PLAYWRIGHT_MODULE=... CHROMIUM=... node --experimental-strip-types test/published-browser.mjs */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { publishedFixture } from "./published-fixture.ts";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const f = await publishedFixture(true, "/prefix/adb/");
const { site, app, appPath } = f;
let browser;
try {
  const dist = resolve(process.env.WEB_DIST ?? "dist");
  for (const file of await readdir(dist, { recursive: true, withFileTypes: true })) {
    if (!file.isFile() || file.name === "server.cjs") continue;
    const path = join(file.parentPath, file.name);
    site.files.set(appPath.slice(0, -1) + path.slice(dist.length), await readFile(path));
  }
  site.files.set(appPath, site.files.get(appPath + "index.html"));
  site.files.set(appPath + "site.json", JSON.stringify({ v: 0 }));
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM, args: ["--no-sandbox", "--disable-gpu"] });
  const page = await browser.newPage();
  await page.context().addCookies([
    { name: "store-session", value: "must-not-be-sent", url: f.store.origin + f.stem + "/" },
    { name: "cdn-session", value: "must-not-be-sent", url: f.cdn.origin + "/objects/" },
  ]);
  const errors = [], requests = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => requests.push(request));
  await page.goto(app + "#/runs");
  await page.locator(`[data-run="${f.card.identity.run}"]`).waitFor();
  await page.goto(app + "#/experiments/example");
  await page.locator("h2").filter({ hasText: "example" }).waitFor();
  const image = page.getByRole("img", { name: "Indexed figure" });
  await image.waitFor();
  assert.equal(await image.getAttribute("src"), app + "index/catalog/assets/example/figure.svg");
  assert.equal(await page.getByText("Publish on completion", { exact: true }).count(), 0);
  assert.equal(await page.locator('a[href="#/jobs"]').count(), 0);
  assert.equal(await page.getByText("oneliner", { exact: true }).count(), 0);
  await page.goto(app + `#/run/condition/${f.card.identity.run}?tab=stream`);
  await page.locator("#ev-1").waitFor();
  await page.locator("#ev-1 > summary").click();
  const raw = page.locator("#ev-1 [data-raw-disclosure]");
  if (!await raw.evaluate((node) => node.open)) await raw.locator("summary").click();
  await raw.getByText("disk line", { exact: true }).click();
  assert.equal(await raw.locator('[data-raw-event="disk line"]').textContent(), f.lines[1]);
  await page.goto(app + `#/run/condition/${f.card.identity.run}?tab=summary`);
  const rawCard = page.locator("[data-raw-run-json]");
  await rawCard.locator("summary").click();
  await rawCard.locator("pre").waitFor();
  assert.equal(await rawCard.locator("pre").textContent(), f.raw);
  await page.goto(app + "#/jobs");
  await page.getByRole("heading", { name: "Experiments", exact: true }).waitFor();
  for (const request of requests) {
    const url = new URL(request.url());
    assert.ok(!url.pathname.includes("/api/"), `Node API request in static mode: ${url.pathname}`);
    const headers = await request.allHeaders();
    assert.equal(headers.authorization, undefined);
    assert.equal(headers.cookie, undefined);
  }
  assert.ok(f.store.requests.some((request) => request.path.endsWith("run.json")));
  assert.ok(f.store.requests.some((request) => request.path.endsWith("events.jsonl.zst")));
  assert.equal(f.store.requests.filter((request) => request.status === 302).length, 2);
  assert.equal(f.cdn.requests.filter((request) => request.status === 200).length, 2);
  assert.ok(f.cdn.requests.every((request) => request.url.includes("X-Amz-Signature=fixture-signature")));
  for (const request of [...f.store.requests, ...f.cdn.requests]) {
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.headers.cookie, undefined);
  }
  assert.ok(site.requests.some((request) => request.path === appPath + "index/index.json"));
  assert.ok(site.requests.some((request) => request.path === appPath + "index/experiments/example/index.jsonl"));
  assert.ok(site.requests.every((request) => request.path.startsWith(appPath)));
  assert.ok(site.requests.some((request) => request.path === appPath + "index/catalog.json"));
  assert.ok(site.requests.some((request) => request.path === appPath + "index/catalog/assets/example/figure.svg"));
  assert.ok(!site.files.has(appPath + "catalog.json"), "Web dist must not bundle a catalog");
  assert.ok(!site.requests.some((request) => request.path === appPath + "catalog.json"));
  const catalog = JSON.parse(site.files.get(appPath + "index/catalog.json").toString());
  assert.deepEqual(catalog.manifests.map((manifest) => manifest.name), ["example"]);
  assert.ok(catalog.hints.example["0"]);
  assert.deepEqual(catalog.shared, { title: "shared" });
  assert.deepEqual(errors, []);
  console.log(`Static published bundle: ${requests.length} requests, including redirects to a signed URL on another host; no credentials on either hop or Node API requests; original card and decompressed raw line preserved.`);
} finally {
  if (browser) await browser.close();
  await f.close();
}
