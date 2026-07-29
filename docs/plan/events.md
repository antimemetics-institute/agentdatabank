# Events

The wire contract between an experiment and everything downstream of it: the
runner that persists its stream, the viewers that render it, and any analysis
that reads it later. One JSON line per event on the experiment's stdout.

The contract has three tiers. Each tier is stricter than the one below it, and
participation in the stricter tiers is opt-in — but never improvised: a
convention is either followed as written or not used at all. Consumers react
only to what an event *declares* (its `type`, an agent.event's `kind`, a
documented field); they never infer meaning from an undeclared shape.

## Tier 1 — transport (runner-owned)

The runner wraps every payload line in the envelope

```json
{"v": 0, "ts": "<capture time>", "run": "<run id>", "seq": <n>, "event": {...}}
```

- `seq` is a total order per run, assigned at capture.
- The payload is stored **verbatim**, always. Envelope keys can never collide
  with payload keys because the payload nests whole under `event`.
- Ingestion lint: a payload that claims a known `type` with the wrong shape, or
  a reserved `run.*` type, earns a companion `log` warning — never mutation,
  never a drop.
- `run.*` types are reserved for runner-synthesized lifecycle events:
  `run.start`, `run.status`, `run.end`.
- `v` is the envelope version; the payload vocabulary below is versioned by
  this spec, not by `v`.

## Tier 2 — payload vocabulary

Nine standard types, defined as msgspec Structs in `lib/adb-events`
(`adb_events/models.py` is the single source of truth for shapes; this section
records the *semantics* the shapes don't carry).

| type | fields | semantics |
|---|---|---|
| `status` | `detail` | one-line progress narration |
| `log` | `message`, `level` | deliberate structured emission |
| `stdout` / `stderr` | `line` | captured process output, runner-synthesized, verbatim |
| `metric` | `name`, `value`, `step?`, `unit?` | a named **run-level** measurement |
| `message` | `from`, `content`, `channel`, `to?`, `visible_to?`, `meta?` | one utterance in a channel |
| `llm.call` | `model`, `request`, `response?`, `usage?`, `latency_ms?`, `error?`, `agent?`, `meta?` | one model call, request/response as sent/received |
| `agent.event` | `agent`, `kind`, `data` | the extension point — see Tier 3 |
| `artifact` | `name`, `path`, `media_type?`, `bytes?` | a file deposited under the run dir |

Decisions the shapes alone don't express:

- **Metric values are scalars** (`int | float | str | bool`). Structured values
  are forbidden — flatten to multiple names (see the `/` join under the
  instance convention).
- **Re-emitting a metric name supersedes it** (last-value-wins). A run's final
  value for `name` is the last one in the stream. Emitting `step` marks the
  event as a point in an ordered **within-trajectory series** (loss per round,
  pool per tick) — the time axis. Per-instance results are *neither* of these:
  they belong on the instance convention, never as repeated same-named metrics.
- **Conformance ladder**: any JSON line is legal (unknown or absent `type` is
  preserved untouched); known types must validate; conventions bind only when
  their declared marker is present.
- **Producer validation**: the typed emitters in `adb_events.emit` validate on
  construction and raise in the experiment's process — a malformed payload is a
  bug caught by the experiment's tests, not a warning three systems later.
  `emit_raw` is the deliberate escape hatch: any JSON, no checks.

## Tier 3 — named conventions (opt-in, declared, never inferred)

Conventions ride on `agent.event` kinds and documented `meta` keys. An
experiment that doesn't need one simply never emits its marker.

### instance — one run working through many units

For runs that process many independent units of work in a single run — the 500
rows of a dataset, swebench instances, arena matches, repeated scenarios. The
unit is an **instance**; running the same instance more than once within the
run is a **repeat**. (Contrast the run-level `replicate`: a fresh process,
seed, and environment. Within-run repeats share all of those — they are
repeated measures inside one session, a different level of the nested design:
condition → run (replicate) → instance → repeat. Keep the axes apart in
analysis; the vocabulary keeps them apart on the wire.)

- **Close-out**: when an instance finishes, emit
  `agent.event` `kind: "instance"` with `data`:
  - `id` (required) — the instance's identity within the run
  - `repeat?` — 1-based counter when the run repeats instances; absent otherwise
  - `scores?` — a **flat scalar map** `{name → int|float|str|bool}`. A scorer
    with structured output flattens at emit with a `/` join:
    `{"combined_scorer/score": 0, "combined_scorer/refusal": 1}`. Values are
    recorded verbatim, never coerced to pass/fail — identity records, never
    judges.
  - `error?` — string, when the instance failed
  - anything else the experiment wants (`target`, domain fields) rides along in
    `data` untyped.
- **Attribution**: events serving an instance (messages, llm.calls, captured
  stdout) carry `meta.instance_id` (and `meta.repeat` when repeating) so
  interleaved work stays attributable.
- **Rooming**: an instance's conversation uses channel `instance:<id>`, so
  channel-aware viewers read one room per instance and can filter to it.
- The typed emitter is `adb_events.emit.instance(...)`.

Viewer commitments (so emitters can predict rendering): per-instance scores
aggregate in the run overview as — booleans → pass ratio (colored), numerics →
mean (neutral: a 0/1 numeric is not judged, its meaning belongs to the
experiment), strings → value distribution. Aggregates are derived at read time
and stored nowhere.

Legacy: streams written before this spec used `kind: "sample"`,
`meta.sample_id`, `meta.epoch`, and `sample:<id>` channels (inspect
vocabulary). Viewers keep reading that shape as an alias; new producers must
not emit it.

### tools — actions an agent took

`agent.event` kinds `tool_call` and `tool_result`. Canonical `data` fields:

- `name` — the tool; `arguments` — its input (object)
- `tool_call_id` — pairing key; a result pairs to its call by id, ordinal order
  is the fallback for id-less streams
- on results: `output` (string), `exit_code?` (int, process-like tools),
  `ok?` (bool, the tool's own success verdict)

`exit_code` and `ok` are the only fields viewers judge (colored pass/fail) —
they are declared verdicts. Free-text sniffing of outputs is not part of the
contract. Legacy synonyms readers still accept: `tool`, `args`, `output_tail`,
`tail`, `result`, `content`, `id`.

### provenance — what exactly ran

`agent.event` `kind: "provenance"`, emitted once near run start by wrappers
that can see upstream identity: package versions, task/dataset identity,
resolved model ids, git revisions. Recorded before anyone knows it matters —
a fact not recorded here can never be sliced on later (see
`comparability.md`).
