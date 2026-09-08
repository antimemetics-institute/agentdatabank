/* Shared DTO types — imported by both the browser app and the node server.
   The authoritative wire format is docs/book/src/reference/events.md (the runner, in Python,
   is the producer); these types mirror it for TS consumers. */

/* one event. On the wire: envelope + payload, {v, ts, run, seq, event: {...}} per the
   spec. The server passes wire shape through; the browser flattens at ingress
   (lib/data.ts flattenEv) so components see payload fields + seq/run/ts flat. */
export type Ev = Record<string, any>;

/* run.json as written by the runner */
export type RunState = "provisioning" | "running" | "completed" | "failed" | "interrupted";
export type JobState = "queued" | "claimed" | "building" | "running"
  | "completed" | "failed" | "stopped" | "orphaned" | "error";

export interface RunMeta {
  run: string;
  condition: string;
  experiment: string;
  state: RunState;
  replicate: number;
  seed?: number;
  started_at?: string;
  finished_at?: string;
  duration_s?: number;
  summary?: Record<string, unknown>;
  result_definitions?: Record<string, ResultDecl>;
  usage_totals?: Record<string, number>;
  /* NOT in run.json — server-enriched: run.json's mtime. The runner heartbeats by
     touching the file every 10s while alive; a stale heartbeat on a `running` run
     renders as `interrupted?` (events spec, Ordering & integrity). */
  heartbeat_at?: string;
  [k: string]: unknown;
}

/* server wire-diet markers (round 7): large param values and quadratic event
   fields are replaced on the wire by these descriptors; full values come from
   /api/params/<ref> and /api/runs/<cid>/<rid>/event/<seq>. Disk records are
   untouched — truncation is strictly a viewer concern (docs/book/src/reference/events.md). */
export interface ParamRef {
  __param_ref: { size: number; preview: string; ref: string };
}
export interface ElidedMarker {
  __elided: { bytes: number; preview?: string };
}

/* conditions/<cid>.json as written by the runner; immutable once written */
export interface Condition {
  experiment: string;
  params: Record<string, unknown>;
  source: string;
  [k: string]: unknown;
}

/* experiment manifest (adb.mkExperiment result → JSON), served by /api/experiments
   from the catalog directory — the schema that drives the run-config builder. */
export interface ParamType {
  kind: string;               /* str|int|float|bool|llm|run|harness|enum|list|struct */
  values?: string[];          /* enum */
  of?: ParamType;             /* list */
  fields?: Record<string, StructField>; /* struct */
}
/* a struct field: a bare type descriptor, or a param-wrapped one when the author
   attached presentation hints (e.g. concordia's per-agent model with suggestions) */
export type StructField = ParamType | { type: ParamType; suggestions?: Suggestion[]; description?: string };
/* one suggestion-list entry: a bare value, or a value with a one-line description
   (e.g. inspect's task catalog carries each task's docstring summary) */
export type Suggestion = string | { value: string; description?: string };
export interface ParamDecl {
  type: ParamType;
  initial?: unknown;
  description?: string;
  /* explicit null is a valid bound value (encoded as `--set k=null`); used for
     upstream kwargs whose declared default is None */
  nullable?: boolean;
  /* presentation order (lower first, default 100) and section label — task-level
     params sort above harness/generation ones; ties break by name */
  order?: number;
  group?: string;
  suggestions?: Suggestion[]; /* free-text-with-datalist (e.g. inspect's task catalog) */
  /* list instantiation bounds, runner-enforced on realized params; the list editors
     gate their remove buttons on minLen */
  minLen?: number;
  maxLen?: number;
  /* variant object: this param's sub-fields depend on another param's value. The GUI
     renders typed sub-boxes from variants[<value of depends_on>]. Wire stays object. */
  depends_on?: string;
  variants?: Record<string, Record<string, ParamDecl>>;
  /* fixed typed sub-form (no depends_on): the GUI renders typed sub-boxes from this
     schema directly (e.g. generate_args from inspect's GenerateConfig). Wire stays object. */
  fields?: Record<string, ParamDecl>;
  [k: string]: unknown;
}
/* one external reference (paper, upstream source, dataset) — presentation only,
   declared by the experiment (mkExperiment `links`) or generated from a wrapped
   package's own metadata (inspect_evals' listing) */
export interface ExtLink {
  label: string;
  url: string;
}
/* one provider prompt-template row, from the runner's registry via the wire —
   the browser never duplicates the registry */
export interface ProviderRow {
  key: string;      /* env var name */
  secret: boolean;
  default: string;  /* prompt default (base URLs); "" for secrets */
}

/* GET /api/credentials: `adb-runner credentials list --json` passed through
   verbatim, plus the server's capability flags. Secret values are literal `true`
   (masked runner-side; the type change makes round-tripping impossible) — plaintext
   secrets NEVER travel this direction. */
export interface CredsInfo {
  /* Local credential access; execution readiness is GET /api/executor. */
  runner: boolean;
  problem?: string;     /* e.g. a group/other-readable store file, with the chmod fix */
  path?: string;        /* server-side store path (shown as provenance, nothing more) */
  prefs_path?: string;
  /* set -> profile -> env var -> value; `true` = a secret exists here */
  store: Record<string, Record<string, Record<string, string | true>>>;
  /* experiment -> set -> remembered profile name (names only, never values) */
  prefs: Record<string, Record<string, string>>;
  providers: Record<string, ProviderRow[]>;
  mock_prefixes: string[];
}

/* one queued launch: POST /api/jobs enqueues it, a WORKER claims and executes it
   and reports back (run ids come from the runner's own run.start envelopes, never
   scraped from log text). $ADB_DATA_DIR/jobs/<id>.json makes it durable — a job
   outlives both the server and the worker that ran it. */
export interface JobInfo {
  id: string;
  experiment: string;
  state: JobState;
  sets: string[];                     /* the exact --set k=v args (no secrets ever) */
  profiles: Record<string, string>;   /* credential set -> profile NAME */
  replicates: number;
  created_at: string;
  finished_at?: string;
  worker?: { id: string; name: string }; /* who claimed it */
  runs: string[];                     /* run ids reported by run.start, in order */
  log: string[];                      /* human tail: worker-reported stderr (capped) */
  exit_code?: number;
  error?: string;
}

export interface ExecutorInfo {
  enabled: boolean;
  ready: boolean;
  source: string | null;
  error: string | null;
}

export interface ResultDecl {
  type: ParamType;
  details?: string;
  label?: string;
  description?: string;
  unit?: string;
}

export interface Manifest {
  name: string;
  summary?: string;
  readme?: string; /* package-directory README Markdown; presentation only */
  links?: ExtLink[];
  schema_version?: number;
  /* Packaging repository, independent of experiment content identity. */
  origin?: string;
  params: Record<string, ParamDecl>;
  results?: Record<string, ResultDecl>;
  env?: Record<string, unknown>;
}
