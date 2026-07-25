/* Record the getting-started clips. Driven by scripts/docs-clips.sh, which serves
   the GUI and passes:
     PLAYWRIGHT_BROWSERS_PATH — nixpkgs playwright-driver.browsers
     BASE_URL      — the running adb-web
     OUT_DIR       — where the PNG frames + fps.txt land
     DARK=1        — record the dark-theme variant
     SCENARIO      — which clip: "builder" | "run-view"

   Scenarios (selectors ride the STABLE ids in hrefs/data attributes, so page
   redesigns don't break them as long as routes and run ids survive):
     builder  — overview → type `hello` into the experiments search (the catalog
                is ~180 cards now) → click the inspect-hello card → dropdown →
                type `anthropic` → pick a model → click the command to copy
     run-view — the builder page (where the previous clip ended) → sidebar "Runs" →
                click the first run row → linger on the transcript

   Quality note: playwright's recordVideo pipes lossy JPEG screencast frames into
   VP8 — mushy text no re-encode can fix. So this captures LOSSLESS PNG frames in a
   tight screenshot loop instead (measured fps written to fps.txt), and the shell
   script encodes those with VP9. The visible fake cursor is an injected element
   riding the real mouse events; its press animation is anchored at the arrow TIP so
   clicks don't jump. */

import { writeFileSync } from "node:fs";
import { chromium } from "playwright-core";

const { BASE_URL, OUT_DIR, DARK, SCENARIO } = process.env;
// must be one of the generated model suggestions (lib/adb-inspect/model_catalog.json)
const MODEL = "anthropic/claude-sonnet-5";

const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-gpu"] });
const context = await browser.newContext({
  viewport: { width: 1024, height: 800 },
  colorScheme: DARK ? "dark" : "light",
  permissions: ["clipboard-read", "clipboard-write"],
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

async function builder() {
  await page.goto(`${BASE_URL}/#/`);
  await page.waitForSelector('a[href$="/experiments/inspect-hello"]');
  await page.mouse.move(700, 60);
  startCapture();
  await page.waitForTimeout(400);

  // the overview is the full ~180-task catalog: search narrows it to hello first
  await glideClick(page.locator('input[type="search"]'));
  await page.keyboard.type("hello", { delay: 130 });
  await page.waitForTimeout(900);

  // click the inspect-hello card (by its route id, not its looks)
  await glideClick(page.locator('a[href$="/experiments/inspect-hello"]'));
  await page.waitForSelector('[data-param="model"] input');
  await page.waitForTimeout(700);

  // the model field: the dropdown opens with ALL suggestions
  await glideClick(page.locator('[data-param="model"] input'));
  await page.waitForSelector('[data-param="model"] li');
  await page.waitForTimeout(800);

  // type `anthropic` — the dropdown narrows — pick the sonnet snapshot
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("anthropic", { delay: 110 });
  await page.waitForTimeout(900);
  await glideClick(page.locator('[data-param="model"] li', { hasText: MODEL }).first());
  await page.waitForTimeout(1000);

  // click the composed command — "copied ✓"
  await glideClick(page.locator("pre", { hasText: "nix run" }));
  await page.waitForTimeout(1200);
}

async function runView() {
  // start where the builder clip ended: the experiment page
  await page.goto(`${BASE_URL}/#/experiments/inspect-hello`);
  await page.waitForSelector('[data-param="model"] input');
  await page.mouse.move(700, 60);
  startCapture();
  await page.waitForTimeout(600);

  // sidebar → Runs
  await glideClick(page.locator('nav a[href="#/runs"]'));
  await page.waitForSelector("tbody tr[data-run]");
  await page.waitForTimeout(1000);

  // click the newest run, take in the header
  await glideClick(page.locator("tbody tr[data-run]").first());
  await page.waitForSelector('[data-filter="all"]', { timeout: 10000 });
  await page.waitForTimeout(1500);

  // narrow the feed with the filter chips: just the conversation, then just the
  // model calls, then everything again
  await glideClick(page.locator('[data-filter="messages"]'));
  await page.waitForTimeout(1600);
  await glideClick(page.locator('[data-filter="llm-calls"]'));
  await page.waitForTimeout(1600);
  await glideClick(page.locator('[data-filter="all"]'));
  await page.waitForTimeout(900);

  // the feed anchors at its end — glide UP through the earlier events
  await page.mouse.move(600, 520, { steps: 20 });
  await smoothScroll(-880);
  await page.waitForTimeout(1400);
}

await (SCENARIO === "run-view" ? runView() : builder());

// render-quality tripwire: the clips exercise the real UI on real run data, so any
// coercion leak ("[object Object]") anywhere on the final page fails the recording
const leaked = await page.evaluate(() => document.body.innerText.includes("[object Object]"));
if (leaked) throw new Error("rendered page contains '[object Object]' — a display coercion leak");

recording = false;
await capture;
writeFileSync(`${OUT_DIR}/fps.txt`, (frames / ((Date.now() - started) / 1000)).toFixed(2));

await context.close();
await browser.close();
