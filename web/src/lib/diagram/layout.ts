/* Scene → positioned scene. Not a layout engine: each named layout is a small
   deterministic arrangement (arena = cast row over a shared environment panel,
   pipeline = left-to-right stages), so the same params always yield the same
   picture and growing the cast grows the canvas predictably. Text is measured
   by character-width approximation — good enough because every string is either
   truncated or wrapped into a fixed slot, never asked to fit exactly. */

import type { Scene, SceneFlow, SceneNode } from "./spec.ts";

export type PositionedNode = SceneNode & {
  x: number; // footprint top-left
  y: number;
  w: number;
  h: number;
  lines?: string[]; // environment only: wrapped label lines
};

export type PositionedFlow = SceneFlow & {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /* which way the connector bows: `down` = vertical drop (arena), `right` =
     horizontal stage hop (pipeline) */
  bow: "down" | "right";
};

export type PositionedScene = {
  w: number;
  h: number;
  nodes: PositionedNode[];
  flows: PositionedFlow[];
};

/* ---- text metrics (approximate, and deliberately so) ---- */

const CHAR_W = 0.58; // average glyph width as a fraction of font-size, sans
export const measure = (text: string, fontSize: number): number =>
  text.length * CHAR_W * fontSize;

export const truncate = (text: string, fontSize: number, maxW: number): string => {
  if (measure(text, fontSize) <= maxW) return text;
  const keep = Math.max(1, Math.floor(maxW / (CHAR_W * fontSize)) - 1);
  return `${text.slice(0, keep).trimEnd()}…`;
};

export const wrap = (text: string, fontSize: number, maxW: number, maxLines: number): string[] => {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (measure(candidate, fontSize) <= maxW || !line) line = candidate;
    else {
      lines.push(line);
      line = word;
      if (lines.length === maxLines - 1) break;
    }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) lines.length = maxLines;
  /* anything that didn't fit ⇒ ellipsis on the last kept line */
  const kept = lines.join(" ");
  if (kept.length < text.trim().length && lines.length > 0)
    lines[lines.length - 1] = truncate(`${lines[lines.length - 1]}…`, fontSize, maxW);
  return lines;
};

/* ---- card geometry (shared by every tile-shaped kind) ---- */

export const TILE = 56; // glyph tile side
export const SLOT_W = 128; // fixed footprint width for tile cards — even rows
const LABEL_FS = 12.5;
const DETAIL_FS = 10.5;
const BADGE_H = 17;

const cardH = (n: SceneNode): number =>
  TILE + 8 + 15 + (n.detail ? 14 : 0) + (n.badge ? 4 + BADGE_H : 0);

export const cardText = (n: SceneNode) => ({
  label: truncate(n.label || n.kind, LABEL_FS, SLOT_W),
  detail: n.detail ? truncate(n.detail, DETAIL_FS, SLOT_W) : undefined,
  badge: n.badge ? truncate(n.badge, 9.5, SLOT_W - 18) : undefined,
});

/* ---- arena: cast row(s) on top, environment panel below, drivers at the side ---- */

const PAD = 26;
const ROW_GAP = 30; // between cast rows
const CAST_GAP = 26; // between cards in a row
const DROP = 64; // vertical space the agent→environment flows curve through
const ENV_FS = 11.5;
const PER_ROW = 5;

const layoutArena = (scene: Scene): PositionedScene => {
  const cast = scene.nodes.filter((n) => n.kind === "agent");
  const drivers = scene.nodes.filter((n) => n.kind === "orchestrator" || n.kind === "model");
  const env = scene.nodes.find((n) => n.kind === "environment");
  const rest = scene.nodes.filter((n) => !cast.includes(n) && !drivers.includes(n) && n !== env);

  const nodes: PositionedNode[] = [];

  /* cast rows, centered on the widest row */
  const rows: SceneNode[][] = [];
  for (let i = 0; i < cast.length; i += PER_ROW) rows.push(cast.slice(i, i + PER_ROW));
  const rowW = (r: SceneNode[]) => r.length * SLOT_W + (r.length - 1) * CAST_GAP;
  const castW = Math.max(0, ...rows.map(rowW));

  /* environment panel sized to the cast (never narrower than a readable line) */
  const envW = Math.max(340, castW);
  const envLines = env ? wrap(env.label, ENV_FS, envW - 36, 3) : [];
  const envH = env ? 30 + envLines.length * 16 + 12 : 0;

  const driverW = drivers.length ? SLOT_W + 34 : 0; // side column, incl. flow room
  const width = PAD * 2 + Math.max(castW, envW) + driverW;
  const castX0 = PAD + (Math.max(castW, envW) - castW) / 2;

  let y = PAD;
  for (const row of rows) {
    const h = Math.max(...row.map(cardH));
    let x = castX0 + (castW - rowW(row)) / 2;
    for (const n of row) {
      nodes.push({ ...n, x, y, w: SLOT_W, h });
      x += SLOT_W + CAST_GAP;
    }
    y += h + ROW_GAP;
  }
  if (rows.length) y += DROP - ROW_GAP;

  const envY = y;
  if (env) {
    const envX = PAD + (Math.max(castW, envW) - envW) / 2;
    nodes.push({ ...env, x: envX, y: envY, w: envW, h: envH, lines: envLines });
    y += envH;
  }

  /* drivers: side column; the first driver's TILE center sits on the panel's
     midline so its flow reads as one straight address into the scene */
  if (drivers.length) {
    const dx = width - PAD - SLOT_W;
    let dy = Math.max(PAD, envY + envH / 2 - TILE / 2);
    for (const d of drivers) {
      nodes.push({ ...d, x: dx, y: dy, w: SLOT_W, h: cardH(d) });
      dy += cardH(d) + 18;
    }
  }

  /* anything unexpected still shows up (a spec bug should be visible, not lost) */
  let ry = y + PAD;
  for (const n of rest) {
    nodes.push({ ...n, x: PAD, y: ry, w: SLOT_W, h: cardH(n) });
    ry += cardH(n) + 18;
  }

  const height = Math.max(y, ry, ...nodes.map((n) => n.y + n.h)) + PAD;
  return { w: width, h: height, nodes, flows: routeFlows(scene.flows, nodes) };
};

/* ---- pipeline: spec order left → right; forEach instances stack in a column ---- */

const STAGE_GAP = 66;

const layoutPipeline = (scene: Scene): PositionedScene => {
  /* group instances of the same spec node (`x.0`, `x.1`) into one column */
  const columns: SceneNode[][] = [];
  const colOf = new Map<string, SceneNode[]>();
  for (const n of scene.nodes) {
    const base = n.id.replace(/\.\d+$/, "");
    const col = colOf.get(base);
    if (col) col.push(n);
    else {
      const fresh = [n];
      colOf.set(base, fresh);
      columns.push(fresh);
    }
  }

  const colH = (col: SceneNode[]) =>
    col.reduce((acc, n) => acc + cardH(n) + 22, -22);
  const maxColH = Math.max(0, ...columns.map(colH));

  /* single-card columns hang their TILE center on one shared axis, so stage
     flows run dead straight; only a stacked (forEach) column centers as a block */
  const axis = PAD + Math.max(TILE / 2, maxColH / 2);
  const nodes: PositionedNode[] = [];
  let x = PAD;
  for (const col of columns) {
    let cy =
      col.length === 1 ? axis - TILE / 2 : Math.max(PAD, axis - colH(col) / 2);
    for (const n of col) {
      nodes.push({ ...n, x, y: cy, w: SLOT_W, h: cardH(n) });
      cy += cardH(n) + 22;
    }
    x += SLOT_W + STAGE_GAP;
  }
  return {
    w: x - STAGE_GAP + PAD,
    h: Math.max(...nodes.map((n) => n.y + n.h), PAD) + PAD,
    nodes,
    flows: routeFlows(scene.flows, nodes, "right"),
  };
};

/* ---- flow endpoints: nearest sensible edges of the two footprints ---- */

const routeFlows = (
  flows: SceneFlow[],
  nodes: PositionedNode[],
  bowDefault?: "right",
): PositionedFlow[] => {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return flows.flatMap((f): PositionedFlow[] => {
    const a = byId.get(f.from);
    const b = byId.get(f.to);
    if (!a || !b) return [];
    /* vertical anchors clear the whole footprint (text under a tile included);
       horizontal anchors aim at the tile's visual middle */
    const bottomOf = (n: PositionedNode) => n.y + n.h;
    const midOf = (n: PositionedNode) => n.y + (n.lines ? n.h / 2 : TILE / 2);
    if (bowDefault === "right")
      return [{ ...f, bow: "right" as const, x1: a.x + a.w, y1: midOf(a), x2: b.x, y2: midOf(b) }];
    /* arena: side-by-side ⇒ horizontal hop into the nearest edge, else drop down */
    const horizontal = a.x >= b.x + b.w || a.x + a.w <= b.x;
    if (horizontal) {
      const leftToRight = a.x + a.w <= b.x;
      return [{
        ...f,
        bow: "right" as const,
        x1: leftToRight ? a.x + a.w : a.x,
        y1: midOf(a),
        x2: leftToRight ? b.x : b.x + b.w,
        y2: midOf(b),
      }];
    }
    const down = a.y <= b.y;
    const x2 = Math.min(Math.max(a.x + a.w / 2, b.x + 18), b.x + b.w - 18);
    return [{
      ...f,
      bow: "down" as const,
      x1: a.x + a.w / 2,
      y1: down ? bottomOf(a) + 6 : a.y,
      x2,
      y2: down ? b.y : bottomOf(b) + 6,
    }];
  });
};

export const layoutScene = (scene: Scene): PositionedScene =>
  scene.layout === "pipeline" ? layoutPipeline(scene) : layoutArena(scene);
