# Find and read a run

To explore saved data on your machine, use the browser viewer below or [read the files directly](#how-do-i-read-the-files-without-a-browser). You do not need to launch another experiment.

Start a read-only viewer:

```sh
nix run .#adb-web
```

The launcher opens the browser and prints its address. If you already have `adb-local` running, use that browser window: it includes the same run viewer. Both use the [default data directory](../reference/layout.md#where-are-runs-saved) unless you select another one.

To inspect a different store, pass its root directory:

```sh
nix run .#adb-web -- --data-dir /path/to/adb-data
```

## How do I find the run?

On **Experiments**, search by experiment name or summary. Sort the cards by name, run count or recent activity, then open an experiment to see its runs. **Runs** shows runs across all experiments.

A run row shows its condition, run ID, replicate, state, results and start time. The parameter column highlights values that vary among that experiment's runs; a dash does not mean the run had no inputs. Open the row to see the full record.

If you launched a run in the terminal, open its printed **watch** link. The link names the run ID and resolves it within the store served by that viewer. If it reports that the run is missing, check that the viewer and runner use the same data directory.

## What should I check first?

Read the state and results at the top of the run page. Expand the metrics and parameters control to inspect the inputs and additional results. The header also shows the run seed, replicate number and, when the run has ended, reported model-call and token totals.

A **completed** state means the experiment process exited successfully. It does not establish that every evaluation instance succeeded: an adapter can catch an error and report it as a result. Check error counts and logs as well as the process state. A failed or interrupted run can still contain useful partial evidence.

An **interrupted?** display means the saved run still says it is active but its heartbeat is stale. It is an inference about liveness, not a newly recorded outcome. See [run states](../reference/layout.md#what-do-the-states-mean).

## How do I inspect the evidence?

The event feed shows the recorded execution in order. Filter chips appear for the kinds of events present in this run: messages, model calls, metrics, instances, agent events and logs. Select **all** to restore the whole feed.

Open an event row to inspect its details and raw event JSON. For a model call, check the requested model, request, response, usage and any error. A message records communication within an experiment; a model call records the request to a model. These serve different purposes and need not have a one-to-one relationship.

For evaluations containing many independent items, use **instances** to inspect their individual scores and errors. A repeat within an instance belongs to that run; it is separate from repeating the entire experiment with another run-level replicate.

An artifact event gives the name and path of a saved file. Resolve that path relative to the run directory printed by the runner. The [file reference](../reference/layout.md) explains how to find it without the terminal output.

## What does a headline result summarize?

The experiment declares which metric names belong in the run summary. If it emits a metric name more than once, the last value is used; earlier values remain in the event feed. The viewer also derives aggregate displays from instance scores. Use the underlying events when you need to understand an aggregate or compare runs with different completion counts.

The [event reference](../reference/events.md) defines fields and conventions. [Repeat and compare runs](../running/model.md) explains what a shared condition ID does and does not establish.

## How do I read the files without a browser?

Start with the **store** path printed by the runner. To locate an older run, look under `runs/CONDITION_ID/RUN_ID/` in your [data directory](../reference/layout.md#where-are-runs-saved). Its `run.json` identifies the experiment, condition, source reference and state. The corresponding `conditions/CONDITION_ID.json` contains the input configuration.

With Python 3, this example prints the metadata and reads metric and completion events. Replace `/path/to/run` with that run's directory:

```sh
python3 - /path/to/run <<'PYTHON'
import json
import sys
from pathlib import Path

run_dir = Path(sys.argv[1])
print(json.dumps(json.loads((run_dir / "run.json").read_text()), indent=2))
for chunk in sorted(run_dir.glob("events-*.jsonl")):
    for line in chunk.read_text().splitlines():
        envelope = json.loads(line)
        event = envelope["event"]
        if event.get("type") in {"metric", "run.end"}:
            print(json.dumps(envelope))
PYTHON
```

Use this example on a finished run; a live file can end with a line still being written. For live processing, use the runner's [`--json` stream](../running/experiments.md#how-do-i-inspect-the-result). Read chunks in filename order and preserve the envelope's run ID and sequence number when combining records. Other event types contain messages, model requests and responses, instance outcomes and artifact pointers. Artifact paths are relative to the run directory.

The [file reference](../reference/layout.md) and [event reference](../reference/events.md) define the fields. Check completion, errors and the evidence behind summary metrics before using a result in an analysis; matching condition IDs alone do not establish scientific comparability.
