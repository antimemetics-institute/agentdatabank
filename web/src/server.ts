/* adb-web server: zero runtime dependencies (node stdlib only — the React/Tailwind
   stack is frontend/build-time; nothing of it runs here). A dumb pipe with a WIRE
   DIET: the disk record is served faithfully but thinly —

   - /api/runs returns THIN summaries (no params) with a store-fingerprint ETag so
     the 2s poll is a 304 in the common case;
   - /api/conditions/<cid> replaces large param values (> ~2 KB) with
     {__param_ref: {size, preview, ref}} descriptors; /api/params/<cid>/<key>
     serves one full value on demand;
   - the events endpoint ELIDES the quadratic parts (request.messages,
     response.raw, any string > ~4 KB) into {__elided: {bytes, preview}} markers;
     /api/runs/<cid>/<rid>/event/<seq> serves one full event on demand. The disk
     record stays untouched — "truncation is strictly a viewer concern"
     (specs/events.md);
   - immutable data (conditions, params, terminal runs' events) is served with
     strong ETags + long-lived Cache-Control;
   - responses over ~1 KB are gzipped (node:zlib — still stdlib) when the client
     accepts it: event streams are key-repetitive JSON and compress ~10x.

   Bundled by esbuild via build.sh; run as `node dist/server.cjs` (the nix wrapper
   does this); `dev.sh` runs this file directly via node's type stripping. */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, extname, normalize, sep } from "node:path";
import { gzipSync } from "node:zlib";
import { parseArgs } from "node:util";
import type { Ev, RunMeta } from "./shared/types";

/* Config policy: USER INTENT is flags (--host/--port/--home/--no-open — explicit,
   discoverable); env is kept for two things only: deployment wiring the nix wrapper
   bakes (ADB_WEB_STATIC / ADB_WEB_MANIFESTS — a user never types those) and the
   cross-tool context ADB_HOME shares with the runner. Where both exist: flag > env
   > default. */
const { values: args } = parseArgs({
  options: {
    host: { type: "string" },
    port: { type: "string" },
    home: { type: "string" },
    "no-open": { type: "boolean" },
    help: { type: "boolean" },
  },
});
if (args.help) {
  console.log(
    "adb-web [--host ADDR] [--port N] [--home DIR] [--no-open]\n\n" +
    "  --host ADDR   bind address (default 127.0.0.1; 0.0.0.0 exposes to the network)\n" +
    "  --port N      listen port (default 8340; walks up if taken)\n" +
    "  --home DIR    run store to serve (default $ADB_HOME, else ~/.local/share/adb)\n" +
    "  --no-open     don't open the browser (also: ADB_NO_OPEN=1)",
  );
  process.exit(0);
}

const HOME =
  args.home ??
  process.env.ADB_HOME ??
  join(process.env.XDG_DATA_HOME ?? join(process.env.HOME ?? ".", ".local", "share"), "adb");
const STATIC = process.env.ADB_WEB_STATIC ?? null;
/* dir of <name>.json experiment manifests (the nix adb-web wrapper points this at the
   manifests linkFarm); drives the run-config builder. Absent in bare `dev.sh` → the
   builder degrades to a note. */
const MANIFESTS = process.env.ADB_WEB_MANIFESTS ?? null;
const PORT = Number(args.port ?? process.env.ADB_PORT ?? "8340");
/* bind address. Default loopback — this serves your local run data; opt into other
   interfaces explicitly (`--host 0.0.0.0`, e.g. behind a code-server/reverse proxy). */
const HOST = args.host ?? process.env.ADB_HOST ?? "127.0.0.1";
const NO_OPEN = Boolean(args["no-open"] || process.env.ADB_NO_OPEN);

const PARAM_REF_LIMIT = 2048; /* param values above this become descriptors */
const ELIDE_LIMIT = 4096;     /* event string fields above this become markers */

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".jsonl": "application/jsonl",
};

const TERMINAL = new Set(["completed", "failed", "interrupted"]);
const IMMUTABLE = "public, max-age=31536000, immutable";

const acceptsGzip = (req: IncomingMessage): boolean =>
  (req.headers["accept-encoding"] ?? "").toString().includes("gzip");

/* JSON out, gzipped when it pays (streams are key-repetitive JSON: ~10x) */
function json(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const text = JSON.stringify(body);
  const base = { "content-type": "application/json", vary: "accept-encoding", ...headers };
  if (status === 200 && text.length > 1024 && acceptsGzip(req)) {
    res.writeHead(status, { ...base, "content-encoding": "gzip" });
    res.end(gzipSync(text));
    return;
  }
  res.writeHead(status, base);
  res.end(text);
}

/* 304 when the client's If-None-Match matches; otherwise sets the ETag */
function withEtag(
  req: IncomingMessage,
  res: ServerResponse,
  etag: string,
  cacheControl: string,
  body: () => unknown,
): void {
  const inm = req.headers["if-none-match"];
  if (inm === etag) {
    res.writeHead(304, { etag, "cache-control": cacheControl });
    res.end();
    return;
  }
  json(req, res, 200, body(), { etag, "cache-control": cacheControl });
}

/* ---------------- runs list: thin summaries + store fingerprint ---------------- */

interface RunsScan { runs: RunMeta[]; maxMtimeMs: number; count: number }

async function scanRuns(): Promise<RunsScan> {
  const runs: RunMeta[] = [];
  let maxMtimeMs = 0;
  const runsDir = join(HOME, "runs");
  let cids: string[] = [];
  try { cids = await readdir(runsDir); } catch { return { runs, maxMtimeMs, count: 0 }; }
  for (const cid of cids) {
    let rids: string[] = [];
    try { rids = await readdir(join(runsDir, cid)); } catch { continue; }
    for (const rid of rids) {
      try {
        const path = join(runsDir, cid, rid, "run.json");
        const full: Ev = JSON.parse(await readFile(path, "utf8"));
        /* THIN summary: no params (realized or spec) — params belong to the
           condition/run detail endpoints */
        const meta: RunMeta = {
          run: full.run,
          condition: full.condition,
          experiment: full.experiment,
          phase: full.phase,
          replicate: full.replicate,
          seed: full.seed,
          started_at: full.started_at,
          finished_at: full.finished_at,
          duration_s: full.duration_s,
          summary: full.summary,
        };
        /* server-enriched liveness signal: the runner heartbeats by touching
           run.json's mtime every 10s while alive (events spec, Ordering &
           integrity) — a stale heartbeat on a `running` run displays as
           `interrupted?` in the GUI */
        try {
          const st = await stat(path);
          meta.heartbeat_at = st.mtime.toISOString();
          if (st.mtimeMs > maxMtimeMs) maxMtimeMs = st.mtimeMs;
        } catch { /* raced */ }
        runs.push(meta);
      } catch { /* half-written or foreign file — skip, garbage is data but not here */ }
    }
  }
  runs.sort((a, b) => (b.started_at ?? "").localeCompare(a.started_at ?? ""));
  return { runs, maxMtimeMs, count: runs.length };
}

/* ---------------- param descriptors ---------------- */

const preview = (s: string): string => {
  /* skip markdown frontmatter fences so previews show content, not "---" */
  const line = s.split("\n").find((l) => l.trim() && !/^-{3,}$/.test(l.trim())) ?? "";
  return line.trim().slice(0, 160);
};

/* large values become {__param_ref} descriptors; /api/params serves the full value */
function thinParams(cid: string, params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    if (s !== undefined && s.length > PARAM_REF_LIMIT) {
      out[k] = { __param_ref: { size: s.length, preview: preview(s), ref: `${cid}/${k}` } };
    } else out[k] = v;
  }
  return out;
}

async function readCondition(cid: string): Promise<Ev | null> {
  try { return JSON.parse(await readFile(join(HOME, "conditions", `${cid}.json`), "utf8")); }
  catch { return null; }
}

/* ---------------- event elision (viewer concern; disk record untouched) ---------------- */

const elideMarker = (v: unknown, pv: string): Ev => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return { __elided: { bytes: s.length, preview: pv } };
};

/* cheap walk: request.messages and response.raw always elide (that's the
   quadratic conversation fold), any string > ELIDE_LIMIT elides anywhere */
function elideEvent(e: Ev): Ev {
  let changed = false;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      if (v.length > ELIDE_LIMIT) { changed = true; return elideMarker(v, v.slice(0, 200)); }
      return v;
    }
    if (Array.isArray(v)) {
      const arr = v.map(walk);
      return changed ? arr : v;
    }
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) out[k] = walk(val);
      return out;
    }
    return v;
  };
  const out: Ev = { ...e };
  /* the quadratic parts live inside the payload (`event` per the envelope spec);
     fall back to the line itself for pre-envelope streams */
  const body: Ev = out.event && typeof out.event === "object"
    ? (out.event = { ...(out.event as Ev) })
    : out;
  if (body.request && typeof body.request === "object" && body.request.messages !== undefined) {
    const msgs = body.request.messages;
    body.request = {
      ...body.request,
      messages: elideMarker(msgs, `${Array.isArray(msgs) ? msgs.length : "?"} messages`),
    };
    changed = true;
  }
  if (body.response && typeof body.response === "object" && body.response.raw !== undefined) {
    body.response = { ...body.response, raw: elideMarker(body.response.raw, "raw provider response") };
    changed = true;
  }
  const walked = walk(out) as Ev;
  return changed ? walked : e;
}

async function runEvents(cid: string, rid: string, after: number): Promise<Ev[] | null> {
  const dir = join(HOME, "runs", cid, rid);
  let files: string[] = [];
  try { files = (await readdir(dir)).filter((f) => /^events-\d+\.jsonl$/.test(f)).sort(); }
  catch { return null; }
  const events: Ev[] = [];
  for (const file of files) {
    for (const line of (await readFile(join(dir, file), "utf8")).split("\n")) {
      if (!line) continue;
      try {
        const ev = JSON.parse(line);
        if ((ev.seq ?? 0) > after) events.push(elideEvent(ev));
      } catch { /* torn tail line of a live run — next poll gets it */ }
    }
  }
  return events;
}

/* one FULL event by seq — what the client fetches when it hits an __elided marker */
async function fullEvent(cid: string, rid: string, seq: number): Promise<Ev | null> {
  const dir = join(HOME, "runs", cid, rid);
  let files: string[] = [];
  try { files = (await readdir(dir)).filter((f) => /^events-\d+\.jsonl$/.test(f)).sort(); }
  catch { return null; }
  for (const file of files) {
    for (const line of (await readFile(join(dir, file), "utf8")).split("\n")) {
      if (!line) continue;
      try {
        const ev = JSON.parse(line);
        if (ev.seq === seq) return ev;
      } catch { /* torn tail */ }
    }
  }
  return null;
}

async function runPhase(cid: string, rid: string): Promise<string | null> {
  try {
    return JSON.parse(await readFile(join(HOME, "runs", cid, rid, "run.json"), "utf8")).phase ?? null;
  } catch { return null; }
}

/* the experiment manifests (schema for the run-config builder) — one JSON per
   experiment in the ADB_WEB_MANIFESTS dir; [] when the dir is unset/unreadable */
async function readManifests(): Promise<unknown[]> {
  if (!MANIFESTS) return [];
  let files: string[] = [];
  try { files = (await readdir(MANIFESTS)).filter((f) => f.endsWith(".json")); }
  catch { return []; }
  const out: unknown[] = [];
  for (const f of files) {
    try { out.push(JSON.parse(await readFile(join(MANIFESTS, f), "utf8"))); }
    catch { /* foreign/half-written file — skip */ }
  }
  return out;
}

async function serveStatic(req: IncomingMessage, res: ServerResponse, urlPath: string): Promise<boolean> {
  if (!STATIC) return false;
  const rel = normalize(urlPath === "/" ? "index.html" : urlPath.slice(1));
  if (rel.startsWith("..") || rel.includes(`..${sep}`)) return false;
  const path = join(STATIC, rel);
  try {
    const body = await readFile(path);
    const type = MIME[extname(path)] ?? "application/octet-stream";
    if (body.length > 1024 && type.startsWith("text/") && acceptsGzip(req)) {
      res.writeHead(200, { "content-type": type, "content-encoding": "gzip", vary: "accept-encoding" });
      res.end(gzipSync(body));
      return true;
    }
    res.writeHead(200, { "content-type": type });
    res.end(body);
    return true;
  } catch { return false; }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] === "api") {
      if (parts[1] === "runs" && parts.length === 2) {
        /* thin list + store-fingerprint ETag: 2s polls are 304s when nothing moved */
        const scan = await scanRuns();
        return withEtag(req, res, `"runs-${scan.count}-${Math.round(scan.maxMtimeMs)}"`,
          "no-cache", () => scan.runs);
      }
      if (parts[1] === "experiments" && parts.length === 2) {
        /* manifests are per-build-immutable; no-cache is fine (tiny, rarely fetched) */
        return json(req, res, 200, await readManifests(), { "cache-control": "no-cache" });
      }
      if (parts[1] === "runs" && parts.length === 5 && parts[4] === "events") {
        const [, , cid, rid] = parts as [string, string, string, string];
        const events = await runEvents(cid, rid, Number(url.searchParams.get("after") ?? "-1"));
        if (events === null) return json(req, res, 404, { error: "no such run" });
        const phase = await runPhase(cid, rid);
        if (phase && TERMINAL.has(phase)) {
          /* terminal runs' streams never change — immutable */
          return withEtag(req, res, `"ev-${rid}-${phase}-${events.length}"`, IMMUTABLE, () => events);
        }
        return json(req, res, 200, events, { "cache-control": "no-store" });
      }
      if (parts[1] === "runs" && parts.length === 6 && parts[4] === "event") {
        const [, , cid, rid, , seqStr] = parts as [string, string, string, string, string, string];
        const ev = await fullEvent(cid, rid, Number(seqStr));
        if (ev === null) return json(req, res, 404, { error: "no such event" });
        const phase = await runPhase(cid, rid);
        const cc = phase && TERMINAL.has(phase) ? IMMUTABLE : "no-cache";
        return withEtag(req, res, `"evt-${rid}-${seqStr}"`, cc, () => ev);
      }
      if (parts[1] === "conditions" && parts.length === 3) {
        const cid = parts[2]!;
        const cond = await readCondition(cid);
        if (cond === null) return json(req, res, 404, { error: "no such condition" });
        if (cond.params && typeof cond.params === "object")
          cond.params = thinParams(cid, cond.params as Record<string, unknown>);
        /* conditions are immutable once written */
        return withEtag(req, res, `"cond-${cid}"`, IMMUTABLE, () => cond);
      }
      if (parts[1] === "params" && parts.length === 4) {
        const [, , cid, key] = parts as [string, string, string, string];
        const cond = await readCondition(cid);
        const params = cond?.params as Record<string, unknown> | undefined;
        if (!params || !(key in params)) return json(req, res, 404, { error: "no such param" });
        return withEtag(req, res, `"param-${cid}-${key}"`, IMMUTABLE,
          () => ({ value: params[key] }));
      }
      return json(req, res, 404, { error: "unknown endpoint" });
    }
    if (await serveStatic(req, res, url.pathname)) return;
    json(req, res, 404, { error: "not found" });
  } catch (err) {
    json(req, res, 500, { error: String(err) });
  }
});

/* bind PORT, or the next free port above it if it's taken (up to 20) — so a second
   `task web` / stray instance doesn't crash on EADDRINUSE. One `listening` handler
   reads the actually-bound port from server.address(), so retries don't double-log. */
/* open the URL in the user's browser — best-effort and only where it can work:
   there must be a frontend to show, a browser to reach (macOS, or a Linux display —
   over SSH/code-server the browser lives on ANOTHER machine and xdg-open here would
   be wrong), and no ADB_NO_OPEN=1 opt-out. Failures are silently ignored: the URL is
   printed either way. */
function openBrowser(url: string): void {
  if (NO_OPEN) return;
  const canOpen =
    process.platform === "darwin" ||
    Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  if (!canOpen) return;
  const cmd = process.platform === "darwin" ? "open" : "xdg-open";
  try {
    spawn(cmd, [url], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  } catch {
    /* no opener available — the printed URL is the fallback */
  }
}

server.on("listening", () => {
  const addr = server.address();
  const port = addr && typeof addr === "object" ? addr.port : PORT;
  const hasFrontend = Boolean(STATIC && existsSync(STATIC));
  const frontend = hasFrontend ? "" : " (API only — no ADB_WEB_STATIC)";
  /* 0.0.0.0 isn't a clickable URL — print localhost and say what's actually bound */
  const shown = HOST === "0.0.0.0" ? "127.0.0.1" : HOST;
  const bound = HOST === "0.0.0.0" ? " (bound on 0.0.0.0 — reachable from other hosts)" : "";
  const url = `http://${shown}:${port}`;
  console.log(`adb-web: serving ${HOME} on ${url}${frontend}${bound}`);
  if (hasFrontend) openBrowser(url);
});

function listenFrom(port: number, attemptsLeft: number): void {
  server.once("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE" && attemptsLeft > 0) {
      console.log(`adb-web: port ${port} in use, trying ${port + 1}`);
      listenFrom(port + 1, attemptsLeft - 1);
    } else {
      console.error(`adb-web: ${err.message}`);
      process.exit(1);
    }
  });
  server.listen(port, HOST);
}
listenFrom(PORT, 20);
