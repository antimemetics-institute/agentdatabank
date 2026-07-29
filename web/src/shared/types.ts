/* Shared DTO types — imported by both the browser app and the node server.
   The authoritative wire format is docs/plan/events.md (the runner, in Python,
   is the producer); these types mirror it for TS consumers. */

/* one event. On the wire: envelope + payload, {v, ts, run, seq, event: {...}} per the
   spec. The server passes wire shape through; the browser flattens at ingress
   (lib/data.ts flattenEv) so components see payload fields + seq/run/ts flat. */
export type Ev = Record<string, any>;

/* run.json as written by the runner */
export interface RunMeta {
  run: string;
  condition: string;
  experiment: string;
  phase: string;
  replicate: number;
  seed?: number;
  started_at?: string;
  finished_at?: string;
  duration_s?: number;
  summary?: Record<string, unknown>;
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
   untouched — truncation is strictly a viewer concern (docs/plan/events.md). */
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
   from the ADB_WEB_MANIFESTS dir — the schema that drives the run-config builder. */
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
  /* variant object: this param's sub-fields depend on another param's value. The GUI
     renders typed sub-boxes from variants[<value of depends_on>]. Wire stays object. */
  depends_on?: string;
  variants?: Record<string, Record<string, ParamDecl>>;
  /* fixed typed sub-form (no depends_on): the GUI renders typed sub-boxes from this
     schema directly (e.g. generate_args from inspect's GenerateConfig). Wire stays object. */
  fields?: Record<string, ParamDecl>;
  [k: string]: unknown;
}
export interface TemplateDecl {
  description?: string;
  params?: Record<string, unknown>;
  replicates?: number;
}
export interface Manifest {
  name: string;
  summary?: string;
  schema_version?: number;
  /* which instance packaged this experiment — "external" marks the author's own
     repo joining the catalog; the overview pins those cards first */
  origin?: string;
  params: Record<string, ParamDecl>;
  results?: Record<string, unknown>;
  templates?: Record<string, TemplateDecl>;
  env?: Record<string, unknown>;
}
