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
     (docs/plan/events.md);
   - immutable data (conditions, params, terminal runs' events) is served with
     strong ETags + long-lived Cache-Control;
   - responses over ~1 KB are gzipped (node:zlib — still stdlib) when the client
     accepts it: event streams are key-repetitive JSON and compress ~10x.

   Bundled by esbuild via build.sh; run as `node dist/server.cjs` (the nix wrapper
   does this); `dev.sh` runs this file directly via node's type stripping. */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, extname, normalize, resolve, sep } from "node:path";
import { gzipSync } from "node:zlib";
import { parseArgs } from "node:util";
import type { Ev, Manifest, RunMeta } from "./shared/types";
import {
  claim, done, getJob, initJobs, listJobs, listWorkers, registerWorker, report,
  stopJob, submit,
} from "./server/queue";
import { credsList, credsRemember, credsSet } from "./server/runner-cli";

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
    "adb-web [--host ADDR] [--port N] [--home DIR] [--repo DIR] [--no-open]\n\n" +
    "  --host ADDR   bind address (default 127.0.0.1; 0.0.0.0 exposes to the network)\n" +
    "  --port N      listen port (default 8340; walks up if taken)\n" +
    "  --home DIR    run store to serve (default $ADB_HOME, else ~/.local/share/adb)\n" +
    "  --no-open     don't open the browser (also: ADB_NO_OPEN=1)\n\n" +
    "  ADB_WEB_TOKEN a bearer token that lets non-loopback workers and launchers in\n" +
    "                (without it, the launch surface answers loopback only)",
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
/* the one optional capability (baked by the nix adb-web wrapper): the adb-runner
   binary whose `credentials … --json` faces the credential picker proxies. Absent →
   that picker degrades to nothing. Execution needs NOTHING here: adb-web serves
   and queues, workers execute — starting one is the user's explicit act. */
const RUNNER = process.env.ADB_RUNNER ?? null;
/* shared bearer token: the ticket that lets a worker (or launcher) on ANOTHER
   machine use the launch surface. Absent → that surface is loopback-only. */
const TOKEN = process.env.ADB_WEB_TOKEN || null;

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
   experiment in the ADB_WEB_MANIFESTS dir; [] when the dir is unset/unreadable.

   TODO: this catalog is frozen at the wrapper's build while workers build fresh
   per job — map the EXACT discrepancies when the served repo moves under a
   running adb-web (main advances, or a live checkout is edited): stale form
   schema vs the new runner's validation, parseJobBody's unknown-experiment
   check against the old catalog (new experiments unlaunchable, deleted ones
   still offered), and the composed oneliner inheriting the frozen view.
   Enumerate first; the fix is the sources-first design (manifests keyed by
   source, worker = executor + trust set), not a reload hack here. */
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
   Remote launching is a real feature with a real design (runner registration +
   tokens), not a default we back into by serving spawn(2) on all interfaces. */

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

const bearerOk = (req: IncomingMessage): boolean => {
  const auth = (req.headers.authorization ?? "").toString();
  return TOKEN !== null && auth === `Bearer ${TOKEN}`;
};

function writeBlocked(req: IncomingMessage): string | null {
  const origin = req.headers.origin;
  if (origin) {
    try { if (new URL(origin).host !== req.headers.host) return "cross-origin request refused"; }
    catch { return "malformed Origin"; }
  }
  if (!LOOPBACK.has(req.socket.remoteAddress ?? "") && !bearerOk(req))
    return TOKEN
      ? "launch/credential/worker endpoints need the bearer token off-loopback"
      : "launch/credential/worker endpoints answer loopback only — use the machine's " +
        "own browser, tunnel the port (ssh -L 8340:127.0.0.1:8340), or set " +
        "ADB_WEB_TOKEN and hand workers the token";
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
  /* external experiments included: they run when a worker is registered for the
     fork repo (its --repo); a worker that isn't fails the build with
     attribute-missing, honestly, into the job log */
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
           compare equal through symlinks and relative --home. */
        let home = resolve(HOME);
        try { home = realpathSync(home); } catch { /* not created yet — absolute is enough */ }
        return json(req, res, 200, { adb: "web", home }, { "cache-control": "no-store" });
      }
      if (parts[1] === "experiments" && parts.length === 2) {
        /* manifests are per-build-immutable; no-cache is fine (tiny, rarely fetched) */
        return json(req, res, 200, await readManifests(), { "cache-control": "no-cache" });
      }
      if (parts[1] === "credentials") {
        /* the whole credential surface — reads too — is the machine-owner's: even a
           masked store (which profiles exist, what's remembered) is that user's
           metadata, not run data */
        const blocked = writeBlocked(req);
        if (blocked) return json(req, res, 403, { error: blocked });
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
        if (!RUNNER) return json(req, res, 409, { error: "server has no ADB_RUNNER — credential editing is off" });
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
      if (parts[1] === "workers") {
        /* the worker protocol: register → claim (long-poll) → report/done (under
           /api/jobs). Same gate as the launch surface: loopback, or the bearer
           token — which is exactly what makes a LAN/remote worker a one-flag
           story instead of a new auth system. */
        const blocked = writeBlocked(req);
        if (blocked) return json(req, res, 403, { error: blocked });
        if (req.method === "GET" && parts.length === 2)
          return json(req, res, 200, listWorkers(), { "cache-control": "no-store" });
        if (req.method === "POST" && parts.length === 3 && parts[2] === "register") {
          const body = await readJsonBody(req) as { name?: unknown; creds?: unknown } | null;
          const name = typeof body?.name === "string" && body.name.trim()
            ? body.name.trim().slice(0, 64) : "worker";
          const worker = registerWorker(name, body?.creds);
          return json(req, res, 200, { worker: worker.id }, { "cache-control": "no-store" });
        }
        if (req.method === "POST" && parts.length === 4 && parts[3] === "claim") {
          const r = claim(HOME, parts[2]!);
          if ("gone" in r) return json(req, res, 410, { error: "unknown worker — re-register" });
          const spec = await r.job;
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
        if (req.method === "POST" && parts.length === 4 && parts[3] === "stop") {
          return stopJob(HOME, parts[2]!)
            ? json(req, res, 200, { ok: true })
            : json(req, res, 404, { error: "no such active job" });
        }
        if (req.method === "POST" && parts.length === 4 && parts[3] === "report") {
          const body = await readJsonBody(req) as Record<string, unknown> | null;
          const r = report(HOME, parts[2]!, {
            phase: typeof body?.phase === "string" ? body.phase : undefined,
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
            phase: typeof body?.phase === "string" ? body.phase : undefined,
            exit_code: typeof body?.exit_code === "number" ? body.exit_code : undefined,
          })
            ? json(req, res, 200, { ok: true })
            : json(req, res, 404, { error: "no such job" });
        }
        if (req.method === "POST" && parts.length === 2) {
          /* enqueue only — execution belongs to whichever worker claims it (the
             locally-supervised one, or any `adb-worker --server <here>`) */
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
/* prior jobs reload as records (non-terminal ones as `orphaned`) before we serve */
void initJobs(HOME).then(() => listenFrom(PORT, 20));
