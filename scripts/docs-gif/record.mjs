/* Record the getting-started clips. Driven by scripts/docs-clips.sh, which serves
   the GUI and passes:
     PLAYWRIGHT_BROWSERS_PATH — nixpkgs playwright-driver.browsers
     BASE_URL      — the running adb-web
     OUT_DIR       — where the PNG frames + fps.txt land
     DARK=1        — record the dark-theme variant
     SCENARIO      — "choose" | "model-credentials" | "launch" | "run-view"

   Each scenario records one guide step. Later steps prepare the preceding UI
   state off-camera. Only launch and run-view enqueue saved-event replay jobs.

   Quality note: playwright's recordVideo pipes lossy JPEG screencast frames into
   VP8 — mushy text no re-encode can fix. So this captures LOSSLESS PNG frames in a
   tight screenshot loop instead (measured fps written to fps.txt), and the shell
   script encodes those with VP9. The visible fake cursor is an injected element
   riding the real mouse events; its press animation is anchored at the arrow TIP so
   clicks don't jump. */

import { writeFileSync } from "node:fs";
import { chromium } from "playwright-core";

const { BASE_URL, OUT_DIR, DARK, SCENARIO } = process.env;
// Recording-only replay: original GovSim events, with no provider execution.
const MODEL = "openai/gpt-6-astra";
const EXAMPLE_KEY = "sk-example-not-a-real-api-key";
let replayJobs = 0;

const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-gpu"] });
const context = await browser.newContext({
  viewport: { width: 1024, height: 800 },
  colorScheme: DARK ? "dark" : "light",
  permissions: ["clipboard-read", "clipboard-write"],
});

// The isolated server uses the saved-event replay build hook.
await context.route("**/*", async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  if (url.origin !== new URL(BASE_URL).origin) {
    throw new Error(`unexpected external browser request: ${url.origin}`);
  }
  if (url.pathname === "/api/jobs" && request.method() === "POST") {
    const job = request.postDataJSON();
    if (job.experiment !== "govsim" || !job.sets.includes(`model=${MODEL}`))
      throw new Error("unexpected recording job");
    if (!job.sets.includes("temperature=null") || !job.sets.includes("top_p=null"))
      throw new Error("recording must submit the visible null generation settings");
    replayJobs++;
    await route.continue({ postData: JSON.stringify(job) });
    return;
  }
  if (url.pathname === "/api/credentials" && request.method() === "POST") {
    const body = request.postDataJSON();
    if (body.set !== "openai" || body.values.OPENAI_API_KEY !== EXAMPLE_KEY || Object.keys(body.values).length !== 1)
      throw new Error("recording must save only its fake example key");
  }
  await route.continue();
});

// the fake cursor: rides real mousemove/mousedown events, so page.mouse.* drives it
await context.addInitScript(() => {
  window.addEventListener("DOMContentLoaded", () => {
    const c = document.createElement("div");
    Object.assign(c.style, {
      position: "fixed", left: "0", top: "0", zIndex: "99999",
      pointerEvents: "none", transform: "translate(-30px,-30px)",
    });
    c.innerHTML =
      '<svg width="22" height="22" viewBox="0 0 24 24" style="filter:drop-shadow(0 1px 2px rgba(0,0,0,.5))">' +
      '<path d="M4 2 L4 19 L8.5 15.5 L11.5 22 L14 21 L11 14.5 L17 14 Z" ' +
      'fill="#fff" stroke="#000" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    document.body.appendChild(c);
    const style = document.createElement("style");
    style.textContent = 'span:has(> a[href="#/jobs"]) { display: none !important; }';
    document.head.appendChild(style);
    const svg = c.firstElementChild;
    svg.style.transformOrigin = "4px 2px"; // press scales around the arrow tip
    svg.style.transition = "transform 0.1s";
    document.addEventListener("mousemove", (e) => {
      c.style.transform = `translate(${e.clientX}px,${e.clientY}px)`;
    }, true);
    document.addEventListener("mousedown", () => { svg.style.transform = "scale(0.8)"; }, true);
    document.addEventListener("mouseup", () => { svg.style.transform = "scale(1)"; }, true);
  });
});

const page = await context.newPage();
page.setDefaultTimeout(30000);
const initialCreds = await (await context.request.get(`${BASE_URL}/api/credentials`)).json();
if (Object.keys(initialCreds.store).length || Object.keys(initialCreds.prefs).length)
  throw new Error("recording requires empty credential and preference stores");

// lossless capture loop: as fast as screenshots come (~15-25/s); fps measured
let frames = 0;
let recording = false;
let started = 0;
let capture = Promise.resolve();
const startCapture = () => {
  recording = true;
  started = Date.now();
  capture = (async () => {
    while (recording) {
      const path = `${OUT_DIR}/f${String(frames).padStart(5, "0")}.png`;
      try { await page.screenshot({ path, timeout: 3000 }); frames++; }
      catch { /* a frame lost mid-navigation is fine */ }
    }
  })();
};

const glideTo = async (locator) => {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  const x = box.x + Math.min(box.width / 2, 120);
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y, { steps: 35 });
  await page.waitForTimeout(350);
  return { x, y };
};
const glideClick = async (locator) => {
  const p = await glideTo(locator);
  await page.mouse.click(p.x, p.y);
};

// eased scroll: many small wheel ticks with cosine ease-in-out, so the capture
// shows a glide instead of discrete jumps
const smoothScroll = async (totalDy, ms = 2200) => {
  const steps = Math.max(20, Math.round(ms / 40));
  const ease = (t) => (1 - Math.cos(Math.PI * t)) / 2;
  let emitted = 0;
  for (let i = 1; i <= steps; i++) {
    const target = totalDy * ease(i / steps);
    const delta = Math.round(target - emitted);
    emitted += delta;
    if (delta !== 0) await page.mouse.wheel(0, delta);
    await page.waitForTimeout(ms / steps);
  }
};

async function saveExampleProfile(visible = false) {
  const key = page.locator('input[type="password"]');
  await key.waitFor();
  if (visible) {
    await key.scrollIntoViewIfNeeded();
    await glideClick(key);
    // Paste a clearly fake key, just as a reader pastes their own provider key.
    await page.evaluate((value) => navigator.clipboard.writeText(value), EXAMPLE_KEY);
    await page.keyboard.press("ControlOrMeta+v");
    await page.waitForTimeout(1000);
    await glideClick(page.getByRole("button", { name: "save", exact: true }));
  } else {
    await key.fill(EXAMPLE_KEY);
    await page.getByRole("button", { name: "save", exact: true }).click();
  }
  await page.locator('select option[value="default"]').waitFor({ state: "attached" });
  await key.waitFor({ state: "detached" });
  if (visible) {
    await page.getByRole("button", { name: "remember", exact: true }).scrollIntoViewIfNeeded();
    await page.waitForTimeout(1300);
    await glideClick(page.getByRole("button", { name: "remember", exact: true }));
    await page.getByText("remembered — the CLI honors it too", { exact: true }).waitFor();
    await page.waitForTimeout(1400);
  }
}

async function openExperiment() {
  await page.goto(`${BASE_URL}/#/experiments/govsim`);
  await page.waitForSelector('[data-param="model"] input');
  await page.mouse.move(700, 60);
}

async function choose() {
  await page.goto(`${BASE_URL}/#/`);
  await page.waitForSelector('a[href$="/experiments/govsim"]');
  await page.mouse.move(700, 60);
  startCapture();
  await page.waitForTimeout(700);
  await glideClick(page.locator('input[type="search"]'));
  await page.keyboard.type("govsim", { delay: 130 });
  await page.waitForTimeout(1200);
  await glideClick(page.locator('a[href$="/experiments/govsim"]'));
  await page.waitForSelector('[data-param="model"] input');
  await page.locator('[data-param="max_rounds"] input').fill("1");
  await page.waitForTimeout(5500);
}

async function configure(visible = false) {
  await page.locator('[data-param="max_rounds"] input').fill("1");
  await page.locator('[data-param="embedder"] select').selectOption("mxbai");
  await page.locator('[data-param="temperature"] input').fill("");
  await page.locator('[data-param="top_p"] input').fill("");
  await page.locator('[data-param="reasoning_effort"] select').selectOption("low");
  const model = page.locator('[data-param="model"] input');
  if (visible) {
    await model.scrollIntoViewIfNeeded();
    await glideClick(model);
    await page.waitForSelector('[data-param="model"] li');
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("openai/gpt-6", { delay: 100 });
    await page.waitForTimeout(1200);
    await glideClick(page.locator('[data-param="model"] li').filter({ hasText: MODEL }).first());
    await page.waitForTimeout(700);
    await glideClick(page.locator('button[role="tab"]', { hasText: "run" }));
  } else {
    await model.fill(MODEL);
    await page.locator('button[role="tab"]', { hasText: "run" }).click();
  }
  await saveExampleProfile(visible);
  await page.waitForSelector("[data-launch]:not([disabled])", { timeout: 30000 });
}

async function modelCredentials() {
  await openExperiment();
  startCapture();
  await page.waitForTimeout(700);
  await configure(true);
  await page.waitForTimeout(1200);
}

async function launchJob(visible = false) {
  if (visible) await glideClick(page.locator("[data-launch]"));
  else await page.locator("[data-launch]").click();
  const link = page.locator('[data-job] a[href^="#/runs/"]').first();
  await link.waitFor({ timeout: 180000 });
}

async function launch() {
  await openExperiment();
  await configure();
  startCapture();
  await page.waitForTimeout(1200);
  await launchJob(true);
  await glideClick(page.locator('[data-job] a[href^="#/runs/"]').first());
  await page.waitForSelector('[data-filter="llm-calls"]');
  await glideClick(page.locator('[data-filter="llm-calls"]'));
  await page.waitForTimeout(10000);
}

async function runView() {
  await openExperiment();
  await configure();
  await launchJob();
  const deadline = Date.now() + 120000;
  while (true) {
    const runs = await (await context.request.get(`${BASE_URL}/api/runs`)).json();
    if (runs.length === 1 && runs[0].state === "completed") break;
    if (Date.now() > deadline || runs.some(run => ["failed", "interrupted"].includes(run.state)))
      throw new Error("replay did not complete before inspection");
    await page.waitForTimeout(250);
  }
  await page.mouse.move(700, 60);
  startCapture();
  await page.waitForTimeout(800);

  // straight into the run: the job panel's run link
  await glideClick(page.locator('[data-job] a[href^="#/runs/"]').first());
  await page.waitForSelector('[data-filter="all"]', { timeout: 10000 });
  await page.waitForTimeout(1500);

  // narrow the feed with the filter chips: just the conversation, then just the
  // model calls, then everything again
  await glideClick(page.locator('[data-filter="messages"]'));
  await page.waitForTimeout(1000);
  await glideClick(page.locator('summary[title^="message"]').filter({ hasText: "Mayor" }).first());
  await page.waitForTimeout(2300);
  await glideClick(page.locator('[data-filter="llm-calls"]'));
  await page.waitForTimeout(1600);
  await glideClick(page.locator('[data-filter="all"]'));
  await page.waitForTimeout(900);

  // the feed anchors at its end — glide UP through the earlier events
  await page.mouse.move(600, 520, { steps: 20 });
  await smoothScroll(-880);
  await page.waitForTimeout(1400);
}

const scenarios = { choose, "model-credentials": modelCredentials, launch, "run-view": runView };
if (!scenarios[SCENARIO]) throw new Error(`unknown scenario: ${SCENARIO}`);
await scenarios[SCENARIO]();

// render-quality tripwire: the clips exercise the real UI on real run data, so any
// coercion leak ("[object Object]") anywhere on the final page fails the recording
const leaked = await page.evaluate(() => document.body.innerText.includes("[object Object]"));
if (leaked) throw new Error("rendered page contains '[object Object]' — a display coercion leak");

const expectedJobs = ["launch", "run-view"].includes(SCENARIO) ? 1 : 0;
if (replayJobs !== expectedJobs) throw new Error(`expected ${expectedJobs} replay jobs, got ${replayJobs}`);
const jobs = await (await context.request.get(`${BASE_URL}/api/jobs`)).json();
if (jobs.length !== expectedJobs || jobs.some(job => job.experiment !== "govsim" || !job.sets.includes(`model=${MODEL}`)))
  throw new Error("server received an unexpected replay job");
if (expectedJobs) {
  const runs = await (await context.request.get(`${BASE_URL}/api/runs`)).json();
  if (runs.length !== 1) throw new Error("expected one replay run");
  const { condition, run } = runs[0];
  const events = await (await context.request.get(`${BASE_URL}/api/runs/${condition}/${run}/events`)).json();
  const saved = JSON.stringify(events);
  if (!saved.includes("dirty:docs-recording-replay") || !saved.includes(MODEL))
    throw new Error("saved run lacks replay provenance or original model");
  if (!saved.includes('llm.call')) throw new Error("replay did not show live model calls");
  if (SCENARIO === "run-view" && (!saved.includes('message') || !saved.includes('total_harvest')))
    throw new Error("completed replay lacks conversations or simulation results");
}
console.log(`verified ${SCENARIO}: empty initial stores; ${expectedJobs} saved-event replay jobs`);
recording = false;
await capture;
writeFileSync(`${OUT_DIR}/fps.txt`, (frames / ((Date.now() - started) / 1000)).toFixed(2));

await context.close();
await browser.close();
