# Experiment protocol and events

The runner starts the experiment in its run's `workspace/`, sends resolved parameters as JSON on stdin, and sets `ADB_RUN_ID`, `ADB_RUN_DIR`, and `ADB_SEED`. Credentials use the [constructed child environment](../running/secrets.md#how-credentials-reach-the-experiment). Process exit status determines the run outcome: zero → completed, nonzero → failed, signal → interrupted.

## Transport

Emit one JSON payload per stdout line. The runner writes it under `event` in a capture-time envelope:

```json
{"v":0,"ts":"2026-07-26T12:00:00Z","run":"<run-id>","seq":0,"event":{"type":"metric","name":"score","value":0.5}}
```

`seq` increases within each run. Non-JSON stdout and stderr lines become `stdout` and `stderr` events. The [run store](layout.md) retains payloads without viewer truncation; rendered views may elide large fields and fetch them on demand.

`run.start`, `run.status`, and `run.end` are reserved for the runner. Unknown event types are allowed. Known malformed payloads and experiment-emitted `run.*` events receive companion warnings and remain recorded. This lint is not full fault isolation: malformed values can still break downstream aggregation. Do not emit reserved lifecycle events.

## Standard payloads

`lib/adb-events/adb_events/models.py` defines the field shapes; `adb-emit schema` exposes their JSON schemas. Python's `adb_events.emit` helpers validate before emission; `emit_raw` bypasses validation.

| Type | Content |
|---|---|
| `status` | Progress `detail` |
| `log` | `message` and `level` |
| `stdout`, `stderr` | Captured `line` |
| `metric` | `name`, scalar `value`, optional `step` and `unit` |
| `message` | `from`, `content`, `channel`; optional recipients, visibility, metadata |
| `llm.call` | Requested `model`, `request`; optional response, usage, latency, error, agent, metadata |
| `agent.event` | `agent`, `kind`, arbitrary `data` |
| `artifact` | `name`, run-relative `path`; optional media type and byte count |

Metric values are numbers, strings, or booleans. Repeated names are last-value-wins in run summaries; `step` identifies within-run series points. Independent instance scores use the convention below. Model-call capture depends on the adapter: a schema field's existence does not guarantee every adapter records it.

## Instance convention

For multiple work units within one run, emit `agent.event` with `kind: "instance"` when each finishes. Its `data` contains `id`, optional 1-based `repeat`, a flat scalar `scores` map, and optional string `error`. Flatten structured scores with `/`-joined names. Other domain fields may accompany them.

Related messages and model calls carry `meta.instance_id` and, when applicable, `meta.repeat`. Use channel `instance:<id>` for the instance's conversation. `adb_events.emit.instance(...)` implements the close-out event.

```text
condition → run (replicate) → instance → repeat
            fresh process              within the same run
```

The viewer derives boolean pass ratios, numeric means, and string distributions from instance scores. Numeric 0/1 values are not interpreted as verdicts. These aggregates are not stored. Readers also accept older `sample`, `sample_id`, `epoch`, and `sample:<id>` spellings; new producers use the instance convention.

## Tools and provenance

Tool activity uses `agent.event` kinds `tool_call` and `tool_result`: `data.name`, `arguments`, and `tool_call_id`; results add `output`, optional integer `exit_code`, and optional boolean `ok`. The viewer pairs by ID, with ordinal fallback for ID-less streams, and colors only declared `exit_code`/`ok` verdicts. It also accepts older field aliases (`tool`, `args`, `output_tail`, `tail`, `result`, `content`, `id`).

`kind: "provenance"` carries adapter-specific metadata. Inspect records available package/task versions, source revision, and dataset name/location/sample count; those dataset fields are not content hashes. Provenance coverage and emission timing vary by adapter. See [current identity and reproduction limits](../running/model.md#three-distinctions-worth-knowing).
