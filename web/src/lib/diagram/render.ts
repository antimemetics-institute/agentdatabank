/* Positioned scene → SVG markup (a string, no JSX/DOM — runs under node --test
   and in the browser alike). All glyphs are hand-drawn stroke art on a rounded
   tile, one accent hue per node kind so every experiment's picture reads as the
   same family. Text reaching this file is RAW — esc() at this XML boundary is
   the single escaping chokepoint (an agent named `] --> B` is just a label). */

import type { PositionedFlow, PositionedNode, PositionedScene } from "./layout.ts";
import { SLOT_W, TILE, cardText } from "./layout.ts";
import type { NodeKind } from "./spec.ts";

export type Palette = {
  bg: string; // canvas paint ("none" in-app: the page paints)
  surface: string; // panel / chip fill
  ink: string; // primary text
  muted: string; // secondary text, flows
  border: string; // panel / chip stroke
};

/* zinc, matching index.css tokens (hex, not oklch — resvg previews need it) */
export const LIGHT: Palette = {
  bg: "#ffffff", surface: "#f4f4f5", ink: "#18181b", muted: "#71717a", border: "#e4e4e7",
};
export const DARK: Palette = {
  bg: "#131316", surface: "#1e1e23", ink: "#fafafa", muted: "#a1a1aa", border: "#33333a",
};
/* in-app: defer to the live theme tokens so dark-mode flips for free */
export const APP: Palette = {
  bg: "none",
  surface: "var(--color-muted)",
  ink: "var(--color-foreground)",
  muted: "var(--color-muted-foreground)",
  border: "var(--color-border)",
};

/* one accent hue per kind — mid-lightness so the same hex works on both themes */
const ACCENT: Record<NodeKind, string> = {
  agent: "#6366f1", // indigo
  orchestrator: "#f59e0b", // amber
  environment: "#a1a1aa", // stays neutral: the stage, not an actor
  model: "#10b981", // emerald
  dataset: "#0ea5e9", // sky
  judge: "#f43f5e", // rose
};

export const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );

const FONT = `ui-sans-serif, system-ui, 'DejaVu Sans', sans-serif`;
const MONO = `ui-monospace, 'DejaVu Sans Mono', monospace`;

/* ---- glyphs: stroke art inside the TILE, (0,0) = tile top-left ---- */

const stroke = (accent: string, d: string, extra = ""): string =>
  `<path d="${d}" fill="none" stroke="${accent}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" ${extra}/>`;

const glyph = (kind: NodeKind, accent: string): string => {
  switch (kind) {
    case "agent":
      return (
        `<circle cx="28" cy="21.5" r="7" fill="none" stroke="${accent}" stroke-width="1.8"/>` +
        stroke(accent, "M15.5 42.5 C15.5 33.5 21.5 30 28 30 C34.5 30 40.5 33.5 40.5 42.5")
      );
    case "orchestrator": // a narrator: a point speaking the scene into being
      return (
        `<circle cx="21" cy="28" r="3.6" fill="${accent}"/>` +
        stroke(accent, "M28.5 21 A10 10 0 0 1 28.5 35") +
        stroke(accent, "M34 15.5 A18 18 0 0 1 34 40.5")
      );
    case "model": // a chip
      return (
        `<rect x="17" y="18" width="22" height="20" rx="4.5" fill="none" stroke="${accent}" stroke-width="1.8"/>` +
        `<rect x="24" y="25" width="8" height="6" rx="1.5" fill="${accent}"/>` +
        [21, 28, 35].map((x) => stroke(accent, `M${x} 13.5 V18 M${x} 38 V42.5`)).join("")
      );
    case "dataset": // a cylinder
      return (
        `<ellipse cx="28" cy="18.5" rx="12.5" ry="4.8" fill="none" stroke="${accent}" stroke-width="1.8"/>` +
        stroke(accent, "M15.5 18.5 V37 A12.5 4.8 0 0 0 40.5 37 V18.5") +
        stroke(accent, "M15.5 27.5 A12.5 4.8 0 0 0 40.5 27.5")
      );
    case "judge": // a balance
      return (
        stroke(accent, "M28 15.5 V39 M21 40.5 H35 M17.5 19.5 H38.5") +
        stroke(accent, "M13 28 A5.3 5.3 0 0 0 23.5 28 L18.2 19.8 Z") +
        stroke(accent, "M32.5 28 A5.3 5.3 0 0 0 43 28 L37.8 19.8 Z")
      );
    case "environment":
      return ""; // drawn as a panel, not a tile
  }
};

/* ---- cards ---- */

const tint = (accent: string, fillOp: number, strokeOp: number): string =>
  `fill="${accent}" fill-opacity="${fillOp}" stroke="${accent}" stroke-opacity="${strokeOp}"`;

const card = (n: PositionedNode, p: Palette): string => {
  const accent = ACCENT[n.kind];
  const t = cardText(n);
  const tileX = n.x + (n.w - TILE) / 2;
  const cx = n.x + n.w / 2;
  let y = n.y + TILE + 8 + 11;
  let out =
    `<g transform="translate(${tileX} ${n.y})">` +
    `<rect width="${TILE}" height="${TILE}" rx="15" ${tint(accent, 0.09, 0.4)} stroke-width="1.2"/>` +
    glyph(n.kind, accent) +
    `</g>` +
    `<text x="${cx}" y="${y}" text-anchor="middle" font-size="12.5" font-weight="600" fill="${p.ink}" font-family="${FONT}">${esc(t.label)}</text>`;
  if (t.detail) {
    y += 14;
    out += `<text x="${cx}" y="${y}" text-anchor="middle" font-size="10.5" fill="${p.muted}" font-family="${FONT}">${esc(t.detail)}</text>`;
  }
  if (t.badge) {
    const bw = Math.min(SLOT_W, t.badge.length * 5.8 + 14);
    const by = y + 8;
    out +=
      `<rect x="${cx - bw / 2}" y="${by}" width="${bw}" height="17" rx="8.5" fill="${p.surface}" stroke="${p.border}"/>` +
      `<text x="${cx}" y="${by + 12}" text-anchor="middle" font-size="9.5" fill="${p.muted}" font-family="${MONO}">${esc(t.badge)}</text>`;
  }
  return out;
};

const panel = (n: PositionedNode, p: Palette): string => {
  const caption = (n.detail ?? "environment").toUpperCase();
  const lines = n.lines ?? [n.label];
  let out =
    `<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="13" fill="${p.surface}" stroke="${p.border}"/>` +
    `<text x="${n.x + 18}" y="${n.y + 20}" font-size="9" font-weight="700" letter-spacing="1.2" fill="${p.muted}" font-family="${FONT}">${esc(caption)}</text>`;
  lines.forEach((line, i) => {
    out += `<text x="${n.x + 18}" y="${n.y + 37 + i * 16}" font-size="11.5" fill="${p.ink}" font-family="${FONT}">${esc(line)}</text>`;
  });
  return out;
};

/* ---- flows: soft cubics with open-V arrowheads ---- */

const arrow = (x: number, y: number, dx: number, dy: number, color: string): string =>
  /* open V pointing along (dx,dy) — unit axis, ±4.2 spread */
  `<path d="M${x - dx * 6 - dy * 4.2} ${y - dy * 6 + dx * 4.2} L${x} ${y} L${x - dx * 6 + dy * 4.2} ${y - dy * 6 - dx * 4.2}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linecap="round"/>`;

const flow = (f: PositionedFlow, p: Palette): string => {
  const c = p.muted;
  let d: string;
  let head: string;
  let tail: string;
  if (f.bow === "down") {
    const sign = f.y2 >= f.y1 ? 1 : -1;
    const bend = Math.max(18, Math.abs(f.y2 - f.y1) * 0.55);
    d = `M${f.x1} ${f.y1} C${f.x1} ${f.y1 + sign * bend} ${f.x2} ${f.y2 - sign * bend} ${f.x2} ${f.y2}`;
    head = arrow(f.x2, f.y2, 0, sign, c);
    tail = arrow(f.x1, f.y1, 0, -sign, c);
  } else {
    const sign = f.x2 >= f.x1 ? 1 : -1;
    const bend = Math.max(18, Math.abs(f.x2 - f.x1) * 0.55);
    d = `M${f.x1} ${f.y1} C${f.x1 + sign * bend} ${f.y1} ${f.x2 - sign * bend} ${f.y2} ${f.x2} ${f.y2}`;
    head = arrow(f.x2, f.y2, sign, 0, c);
    tail = arrow(f.x1, f.y1, -sign, 0, c);
  }
  let out = `<path d="${d}" fill="none" stroke="${c}" stroke-width="1.5" stroke-opacity="0.75"/>${head}${f.back ? tail : ""}`;
  if (f.label) {
    const mx = (f.x1 + f.x2) / 2;
    const my = (f.y1 + f.y2) / 2 - 6;
    out += `<text x="${mx}" y="${my}" text-anchor="middle" font-size="9.5" fill="${c}" font-family="${FONT}">${esc(f.label)}</text>`;
  }
  return out;
};

/* ---- root ---- */

export const renderSvg = (scene: PositionedScene, p: Palette): string => {
  const bg = p.bg === "none" ? "" : `<rect width="${scene.w}" height="${scene.h}" fill="${p.bg}"/>`;
  const flows = scene.flows.map((f) => flow(f, p)).join("");
  const nodes = scene.nodes
    .map((n) => (n.kind === "environment" ? panel(n, p) : card(n, p)))
    .join("");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${scene.w}" height="${scene.h}" viewBox="0 0 ${scene.w} ${scene.h}" role="img">` +
    bg + flows + nodes + `</svg>`
  );
};
