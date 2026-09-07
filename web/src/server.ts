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
     (docs/book/src/reference/events.md);
   - immutable data (conditions, params, terminal runs' events) is served with
     strong ETags + long-lived Cache-Control;
   - responses over ~1 KB are gzipped (node:zlib — still stdlib) when the client
     accepts it: event streams are key-repetitive JSON and compress ~10x.

   Bundled by esbuild via build.sh; run as `node dist/server.cjs` (the nix wrapper
   does this); `dev.sh` runs this file directly via node's type stripping. */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { spawn, execFile } from "node:child_process";
import { join, extname, normalize, resolve, sep } from "node:path";
import { gzipSync } from "node:zlib";
import { promisify } from "node:util";
import { LocalExecutor } from "./server/executor";
import { readReadmeAsset } from "./server/readme-assets";
import { parseArgs } from "node:util";
import type { Ev, Manifest, RunMeta } from "./shared/types";
import {
  claim, done, getJob, initJobs, listJobs, report, flushJobs, interruptJobs,
  stopJob, submit,
} from "./server/queue";
import { credsList, credsRemember, credsSet } from "./server/runner-cli";

/* Launch flags include wrapper-managed paths; ADB_DATA_DIR remains shared cross-tool context. */
const { values: args } = parseArgs({
  options: {
    host: { type: "string" },
    port: { type: "string" },
    "data-dir": { type: "string" },
    repo: { type: "string" },
    "static-dir": { type: "string" },
    catalog: { type: "string" },
    runner: { type: "string" },
    "executor-python": { type: "string" },
    "execution-source": { type: "string" },
    "viewer-only": { type: "boolean" },
    "no-open": { type: "boolean" },
    help: { type: "boolean" },
  },
});
if (args["viewer-only"] && (args["execution-source"] !== undefined || args.runner !== undefined || args["executor-python"] !== undefined || args.repo !== undefined))
  throw new Error("adb-web is read-only; execution arguments belong to adb-local.");
const EXECUTE = args["execution-source"] !== undefined;
if (args.repo && !EXECUTE) throw new Error("--repo belongs to adb-local; adb-web is read-only.");
if (args.help) {
  console.log(
    `${EXECUTE ? "adb-local [--repo DIR]" : "adb-web"} [--host ADDR] [--port N] [--data-dir DIR] [--no-open]\n\n` +
    "  --host ADDR   bind address (default 127.0.0.1; 0.0.0.0 exposes to the network)\n" +
    "  --port N      listen port (default 8340; walks up if taken)\n" +
    "  --data-dir DIR  run data directory (default $ADB_DATA_DIR, else ~/.local/share/adb)\n" +
    "  --no-open     don't open the browser\n\n" +
    (EXECUTE ? "  --repo DIR   execution source; restart after editing declarations." : "  Read-only viewer. Use adb-local for browser execution."),
  );
  process.exit(0);
}

const HOME = resolve(
  args["data-dir"] ??
  process.env.ADB_DATA_DIR ??
  join(process.env.XDG_DATA_HOME ?? join(process.env.HOME ?? ".", ".local", "share"), "adb"));
const STATIC = args["static-dir"] ?? null;
/* dir of <name>.json experiment manifests (the nix adb-web wrapper points this at the
   manifests linkFarm); drives the run-config builder. Local mode builds it at startup. */
let MANIFESTS = args.catalog ?? null;
const PORT = Number(args.port ?? "8340");
/* bind address. Default loopback — this serves your local run data; opt into other
   interfaces explicitly (`--host 0.0.0.0`, e.g. behind a code-server/reverse proxy). */
const HOST = args.host ?? "127.0.0.1";
const NO_OPEN = Boolean(args["no-open"]);
if (EXECUTE && !["127.0.0.1", "::1", "localhost", "0.0.0.0", "::"].includes(HOST))
  throw new Error("adb-local must bind loopback or a wildcard address; use SSH forwarding for remote access.");
// Only local mode supplies the runner and execution source.
const RUNNER = args.runner ?? null;
const EXECUTOR_PYTHON = args["executor-python"] ?? null;
const source = args.repo ?? args["execution-source"];
const REPO = source ? realpathSync(source) : null;
if (EXECUTE && (!RUNNER || !EXECUTOR_PYTHON || !REPO)) {
  console.error("Local execution needs --execution-source, --runner and --executor-python.");
  process.exit(2);
}
// Credentials subprocesses and executor inherit the exact same context.
process.env.ADB_DATA_DIR = HOME;
const executor = new LocalExecutor(() => interruptJobs(HOME));
let shuttingDown = false;
const startupAbort = new AbortController();

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
          state: full.state,
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

async function runState(cid: string, rid: string): Promise<string | null> {
  try {
    return JSON.parse(await readFile(join(HOME, "runs", cid, rid, "run.json"), "utf8")).state ?? null;
  } catch { return null; }
}

/* Catalog evaluated from the configured execution source at startup. */
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

/* ---------------- the launch/credential surface (guarded writes) ----------------
   The read API serves your run data to whoever can reach the port (you opted into
   that with --host). The LAUNCH surface is different in kind — it executes code and
   writes a secret store — so it is gated on the requester being the machine's own
   user: same-origin (a browser tab on another site can't drive it) AND a loopback
   peer (a network client can't, even when the bind is 0.0.0.0 for remote VIEWING).
   Remote access to local execution uses SSH forwarding. */

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function writeBlocked(req: IncomingMessage): string | null {
  const origin = req.headers.origin;
  if (origin) {
    try { if (new URL(origin).host !== req.headers.host) return "cross-origin request refused"; }
    catch { return "malformed Origin"; }
  }
  if (!LOOPBACK.has(req.socket.remoteAddress ?? ""))
    return "local execution and credentials answer loopback only; use SSH port forwarding";
  return null;
}

const BODY_CAP = 256 * 1024;

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolvePromise, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > BODY_CAP) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolvePromise(JSON.parse(Buffer.concat(chunks).toString("utf8") || "null")); }
      catch { reject(new Error("body is not JSON")); }
    });
    req.on("error", reject);
  });
}

/* the same shape rules the runner enforces — checked here so a bad request dies
   before any spawn, and so nothing surprising ever lands in argv (values that ARE
   free text, the --set payloads, travel as single argv entries; never a shell) */
const EXPERIMENT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const SET_NAME_RE = /^[a-z0-9][a-z0-9_.-]*$/;
const PROFILE_RE = /^[a-z0-9][a-z0-9_-]*$/;
const SET_ARG_RE = /^[A-Za-z_][A-Za-z0-9_]*=[\s\S]*$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface JobBody {
  experiment: string; sets: string[]; profiles: Record<string, string>; replicates: number;
}

async function parseJobBody(body: unknown): Promise<JobBody | string> {
  if (!body || typeof body !== "object") return "expected a JSON object";
  const b = body as Record<string, unknown>;
  const experiment = b.experiment;
  if (typeof experiment !== "string" || !EXPERIMENT_RE.test(experiment))
    return "bad experiment name";
  const manifests = (await readManifests()) as Manifest[];
  const manifest = manifests.find((m) => m.name === experiment);
  if (!manifest) return `unknown experiment "${experiment}"`;
  const sets = Array.isArray(b.sets) ? b.sets : null;
  if (!sets || sets.length > 128 ||
      !sets.every((s) => typeof s === "string" && SET_ARG_RE.test(s)))
    return "sets must be key=value strings";
  const profilesIn = b.profiles && typeof b.profiles === "object" ? b.profiles as Record<string, unknown> : {};
  const profiles: Record<string, string> = {};
  for (const [set, profile] of Object.entries(profilesIn)) {
    if (!SET_NAME_RE.test(set) || typeof profile !== "string" || !PROFILE_RE.test(profile))
      return "bad profile selection";
    profiles[set] = profile;
  }
  const replicates = b.replicates ?? 1;
  if (typeof replicates !== "number" || !Number.isInteger(replicates) ||
      replicates < 1 || replicates > 100)
    return "replicates must be an integer 1..100";
  return { experiment, sets: sets as string[], profiles, replicates };
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
      if (parts[1] === "ping" && parts.length === 2) {
        /* identity probe: the runner walks the ports this server might have bound to
           (8340 upward) looking for a viewer serving the store its runs go to, so it
           can print a link that actually resolves. Deliberately tiny and store-scan
           free — it's hit at every run start. The home is real-pathed so the two sides
           compare equal through symlinks and relative --data-dir. */
        let home = resolve(HOME);
        try { home = realpathSync(home); } catch { /* not created yet — absolute is enough */ }
        return json(req, res, 200, { adb: "web", home }, { "cache-control": "no-store" });
      }
      if (parts[1] === "experiments" && parts.length === 2) {
        /* manifests are per-build-immutable; no-cache is fine (tiny, rarely fetched) */
        return json(req, res, 200, await readManifests(), { "cache-control": "no-cache" });
      }
      if (parts[1] === "experiments" && parts[3] === "assets" && parts.length >= 5) {
        const asset = await readReadmeAsset(MANIFESTS, [parts[2]!, ...parts.slice(4)]);
        if (!asset) return json(req, res, 404, { error: "no such README image" });
        res.writeHead(200, {
          "content-type": asset.type,
          "cache-control": "no-cache",
          "x-content-type-options": "nosniff",
          "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        });
        return res.end(asset.body);
      }
      if (parts[1] === "credentials") {
        /* the whole credential surface — reads too — is the machine-owner's: even a
           masked store (which profiles exist, what's remembered) is that user's
           metadata, not run data */
        const blocked = writeBlocked(req);
        if (blocked) return json(req, res, 403, { error: blocked });
        if (!EXECUTE) return json(req, res, 403, { error: "read-only viewer; use adb-local" });
        if (req.method === "GET" && parts.length === 2) {
          const base = { runner: Boolean(RUNNER) };
          if (!RUNNER)
            return json(req, res, 200,
              { ...base, store: {}, prefs: {}, providers: {}, mock_prefixes: [] },
              { "cache-control": "no-store" });
          const doc = await credsList(RUNNER);
          if (doc === null) return json(req, res, 502, { error: "adb-runner credentials list failed" });
          return json(req, res, 200, { ...base, ...(doc as object) }, { "cache-control": "no-store" });
        }
        if (req.method !== "POST") return json(req, res, 405, { error: "POST only" });
        if (!RUNNER) return json(req, res, 409, { error: "server has no runner — credential editing is off" });
        const body = await readJsonBody(req) as Record<string, unknown> | null;
        if (parts.length === 3 && parts[2] === "remember") {
          const { experiment, set, profile } = (body ?? {}) as Record<string, string>;
          if (typeof experiment !== "string" || !EXPERIMENT_RE.test(experiment) ||
              typeof set !== "string" || !SET_NAME_RE.test(set) ||
              typeof profile !== "string" || !PROFILE_RE.test(profile))
            return json(req, res, 400, { error: "bad remember request" });
          const r = await credsRemember(RUNNER, experiment, set, profile);
          return json(req, res, "error" in r ? 400 : 200, r);
        }
        if (parts.length === 2) {
          const { set, profile, values } = (body ?? {}) as
            { set?: unknown; profile?: unknown; values?: unknown };
          if (typeof set !== "string" || !SET_NAME_RE.test(set) ||
              typeof profile !== "string" || !PROFILE_RE.test(profile) ||
              !values || typeof values !== "object" ||
              !Object.entries(values).every(([k, v]) =>
                ENV_KEY_RE.test(k) && (v === null || typeof v === "string")))
            return json(req, res, 400, { error: "bad credentials request" });
          const r = await credsSet(RUNNER, set, profile, values as Record<string, string | null>);
          return json(req, res, "error" in r ? 400 : 200, r);
        }
        return json(req, res, 404, { error: "unknown endpoint" });
      }
      if (parts[1] === "executor") {
        const blocked = writeBlocked(req);
        if (blocked) return json(req, res, 403, { error: blocked });
        if (req.method === "GET" && parts.length === 2)
          return json(req, res, 200, {
            enabled: EXECUTE, ready: executor.ready && !shuttingDown,
            source: REPO, error: executor.error,
          }, { "cache-control": "no-store" });
        if (!EXECUTE || req.headers["x-adb-executor"] !== executor.capability)
          return json(req, res, 403, { error: "private executor endpoint" });
        if (req.method === "POST" && parts[2] === "claim" && parts.length === 3) {
          if (shuttingDown) { res.writeHead(204); res.end(); return; }
          executor.ready = true;
          const spec = await claim(HOME).job;
          if (!spec) { res.writeHead(204); res.end(); return; }
          return json(req, res, 200, spec, { "cache-control": "no-store" });
        }
        return json(req, res, 404, { error: "unknown endpoint" });
      }
      if (parts[1] === "jobs") {
        if (req.method === "GET" && parts.length === 2)
          return json(req, res, 200, listJobs(), { "cache-control": "no-store" });
        if (req.method === "GET" && parts.length === 3) {
          const job = getJob(parts[2]!);
          return job ? json(req, res, 200, job, { "cache-control": "no-store" })
                     : json(req, res, 404, { error: "no such job" });
        }
        const blocked = writeBlocked(req);
        if (blocked) return json(req, res, 403, { error: blocked });
        if (!EXECUTE) return json(req, res, 403, { error: "read-only viewer; use adb-local" });
        if ((parts[3] === "report" || parts[3] === "done") &&
            req.headers["x-adb-executor"] !== executor.capability)
          return json(req, res, 403, { error: "private executor endpoint" });
        if (req.method === "POST" && parts.length === 4 && parts[3] === "stop") {
          return stopJob(HOME, parts[2]!)
            ? json(req, res, 200, { ok: true })
            : json(req, res, 404, { error: "no such active job" });
        }
        if (req.method === "POST" && parts.length === 4 && parts[3] === "report") {
          const body = await readJsonBody(req) as Record<string, unknown> | null;
          const r = report(HOME, parts[2]!, {
            state: typeof body?.state === "string" ? body.state : undefined,
            runs: Array.isArray(body?.runs)
              ? (body.runs as unknown[]).filter((x): x is string => typeof x === "string") : undefined,
            log: Array.isArray(body?.log)
              ? (body.log as unknown[]).filter((x): x is string => typeof x === "string") : undefined,
          });
          return r ? json(req, res, 200, r) : json(req, res, 404, { error: "no such job" });
        }
        if (req.method === "POST" && parts.length === 4 && parts[3] === "done") {
          const body = await readJsonBody(req) as Record<string, unknown> | null;
          return done(HOME, parts[2]!, {
            state: typeof body?.state === "string" ? body.state : undefined,
            exit_code: typeof body?.exit_code === "number" ? body.exit_code : undefined,
          })
            ? json(req, res, 200, { ok: true })
            : json(req, res, 404, { error: "no such job" });
        }
        if (req.method === "POST" && parts.length === 2) {
          if (shuttingDown || !executor.ready)
            return json(req, res, 503, { error: executor.error ?? "Local executor is not ready." });
          const spec = await parseJobBody(await readJsonBody(req));
          if (typeof spec === "string") return json(req, res, 400, { error: spec });
          const queued = submit(HOME, spec);
          return "error" in queued
            ? json(req, res, 429, queued)
            : json(req, res, 201, queued.job);
        }
        return json(req, res, 404, { error: "unknown endpoint" });
      }
      if (parts[1] === "runs" && parts.length === 5 && parts[4] === "events") {
        const [, , cid, rid] = parts as [string, string, string, string];
        const events = await runEvents(cid, rid, Number(url.searchParams.get("after") ?? "-1"));
        if (events === null) return json(req, res, 404, { error: "no such run" });
        const state = await runState(cid, rid);
        if (state && TERMINAL.has(state)) {
          /* terminal runs' streams never change — immutable */
          return withEtag(req, res, `"ev-${rid}-${state}-${events.length}"`, IMMUTABLE, () => events);
        }
        return json(req, res, 200, events, { "cache-control": "no-store" });
      }
      if (parts[1] === "runs" && parts.length === 6 && parts[4] === "event") {
        const [, , cid, rid, , seqStr] = parts as [string, string, string, string, string, string];
        const ev = await fullEvent(cid, rid, Number(seqStr));
        if (ev === null) return json(req, res, 404, { error: "no such event" });
        const state = await runState(cid, rid);
        const cc = state && TERMINAL.has(state) ? IMMUTABLE : "no-cache";
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
   be wrong), and no --no-open opt-out. Failures are silently ignored: the URL is
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
  const frontend = hasFrontend ? "" : " (API only — no static directory)";
  /* 0.0.0.0 isn't a clickable URL — print localhost and say what's actually bound */
  const shown = HOST === "0.0.0.0" ? "127.0.0.1" : HOST;
  const bound = HOST === "0.0.0.0" ? " (bound on 0.0.0.0 — reachable from other hosts)" : "";
  const url = `http://${shown}:${port}`;
  console.log(`adb-web: serving ${HOME} on ${url}${frontend}${bound}`);
  if (EXECUTE) {
    const address = addr && typeof addr === "object" ? addr.address : HOST;
    const loopback = address === "::" ? "::1" : address === "0.0.0.0" ? "127.0.0.1" : address;
    const localHost = loopback.includes(":") ? `[${loopback}]` : loopback;
    executor.start(EXECUTOR_PYTHON!, `http://${localHost}:${port}`, REPO!, HOME);
    console.log(`adb-local: executing from ${REPO}; restart after editing experiment declarations.`);
  }
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
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  startupAbort.abort();
  await executor.stop(); // keep HTTP open for the final stopped report
  await flushJobs();
  server.close();
  server.closeAllConnections();
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

async function start(): Promise<void> {
  if (EXECUTE) {
    const { stdout } = await promisify(execFile)("nix-build", [REPO!, "--no-out-link", "-A", "manifests"],
      { maxBuffer: 8 * 1024 * 1024, signal: startupAbort.signal });
    MANIFESTS = stdout.trim().split("\n").at(-1)!;
  }
  if (EXECUTE) await initJobs(HOME);
  if (!shuttingDown) listenFrom(PORT, 20);
}
void start().catch((err) => { if (!shuttingDown) { console.error(String(err)); process.exitCode = 1; } });
