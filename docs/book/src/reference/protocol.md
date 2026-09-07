# Experiment process protocol

An experiment executable receives one parameter object and emits event payloads. The runner supplies execution IDs, stores records and determines the process outcome.

## What does the runner provide?

The runner invokes the executable without additional arguments, sets its working directory to the run's fresh `workspace/`, writes the realized parameters as JSON on stdin, then closes stdin.

| Environment variable | Meaning |
| --- | --- |
| `ADB_RUN_ID` | This run's ULID. |
| `ADB_RUN_DIR` | Run directory containing `artifacts/` and `workspace/`. |
| `ADB_SEED` | Derived run seed as a decimal string. |

The child environment starts with only the host values of `PATH`, `HOME`, `LANG`, `LC_ALL`, `TERM`, `TMPDIR` and `DOCKER_HOST`. The runner adds values from selected credential profiles, then its run variables. Arbitrary exported keys and endpoints are not inherited.

A fresh directory and restricted environment are not an operating-system sandbox. The program runs as the launching user and can access resources available to that user. Some experiments use their own Docker-backed tasks; their daemon and service requirements must be met separately.

## What should the program emit?

Write one JSON object per stdout line, flushing promptly for live viewing. Emit only the event payload, for example:

```json
{"type":"metric","name":"count","value":3}
```

The runner adds the [transport envelope](events.md#transport) with version, capture timestamp, run ID and sequence number. A JSON object with an unknown or missing `type` is valid and retained. Standard event types receive structured rendering.

Nonempty stdout lines that are not JSON objects become `stdout` events with a `line` field. Nonempty stderr lines become `stderr` events. The runner preserves their text without inventing a severity level. Blank stdout lines are ignored.

Known event types are checked against the event models. A malformed known payload generates a warning and is preserved unchanged. Experiment-emitted `run.*` types also generate a warning and are retained, but do not determine the runner's stored lifecycle. Reserve `run.*` for the runner.

## How does the run finish?

The runner drains captured output and waits for the process. Exit code zero produces `completed`; a nonzero code produces `failed`; a signal exit or handled interrupt produces `interrupted`. It then emits `run.end` and writes final metadata and summary values.

The phase reports the process outcome. An adapter that catches errors and returns zero should emit metrics, logs or instance errors that make the research outcome clear. A hard runner crash may leave an active phase and an incomplete stream.

## How can Python experiments emit validated events?

Use `adb_events.emit` from the `adb-events` package:

```python
from adb_events.emit import message, metric

message(from_="agent-1", channel="discussion", content="I choose option A.")
metric(name="choices", value=1)
```

Typed emitters validate standard payloads before writing them. `emit_raw(type_, **fields)` emits custom types or extension fields without this validation. `adb_experiment.scaffold.deposit_artifact` writes a text artifact and emits its pointer; its `experiment_main` helper reads and validates parameters but catches run-function exceptions and returns zero with any supplied fallback metrics.

For other languages, emit JSON directly or use `adb-emit`, packaged with `adb-runner`. The [event reference](events.md#emission-tools) describes that CLI and its schema output.
