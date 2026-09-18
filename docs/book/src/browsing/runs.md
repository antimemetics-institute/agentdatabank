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

A run row shows its condition, run ID, state, results and start time. The parameter column highlights values that vary among that experiment's runs; a dash does not mean the run had no inputs. Open the row to see the full record.

If you launched a run in the terminal, open its printed **watch** link. The link names the run ID and resolves it within the store served by that viewer. If it reports that the run is missing, check that the viewer and runner use the same data directory.

## What should I check first?

Open **Summary** for the state, duration, derived model-call and token totals, and declared results. Results appear in manifest order; switch to **definitions** for calculation details and caveats. Inputs and provenance follow the activity counts. The header shows the experiment, condition, run ID and seed. A running run opens on **Stream** unless you have chosen a tab explicitly.

A **completed** state means the experiment process exited successfully. It does not establish that every evaluation instance succeeded: an adapter can catch an error and report it as a result. Check error counts and logs as well as the process state. A failed or interrupted run can still contain useful partial evidence.

An **interrupted?** display means the saved run still says it is active but its heartbeat is stale. It is an inference about liveness, not a newly recorded outcome. See [run states](../reference/layout.md#what-do-the-states-mean).

## How do I inspect the evidence?

The **Stream** tab shows the recorded execution in sequence order. Schema-defined filter chips group dotted kinds by namespace; select a namespace to reveal its individual kinds. Actor chips use the experiment's roster and row labels, with original actor IDs on hover. Select **all** to restore the whole feed. The selected tab and filter are in the URL.

Open a row for its details. Experiment hints supply readable titles, text and ordered fields without changing the record. HTML-text hints strip tags and display plain text. The raw disclosure defaults to highlighted, indented JSON; **disk line** shows exactly the line served from disk, including whitespace and number spellings.

For a model call, the viewer compares its input to the previous call by the same agent across the whole run. If the previous input is a strict prefix, only new messages appear initially; **show all N messages** reveals the complete input. A changed history is shown in full with a note. This comparison is a viewer projection and adds no fields to the data.

System messages initially show their first line; reasoning blocks show their length until opened. User and assistant text is Markdown. Tool results appear under their calls, matched by ID. Call details show requested and served models when they differ, non-default stop reasons, and cache-read tokens when recorded. A model tool request does not establish that a harness executed it.

## What does a headline result summarize?

The experiment declares which result names belong in the summary. If it emits a result name more than once, the last value is used; earlier values remain in the stream. Pending values show an em dash. Model-call and token totals are derived from `llm.call` records. Use the underlying events to understand a result or compare runs with different completion counts.

The [event reference](../reference/events.md) defines fields and conventions. [Repeat and compare runs](../running/model.md) explains what a shared condition ID does and does not establish.

## How do I read the files without a browser?

Start with the **store** path printed by the runner. To locate an older run, look under `runs/CONDITION_ID-EXPERIMENT/RUN_ID/` in your [data directory](../reference/layout.md#where-are-runs-saved). Its `run.json` identifies the experiment, condition, source reference and state. The card also contains `inputs.params` and `provenance.source`, copied from `run.start`. Readers derive conditions by grouping cards on `condition`; shared fields come from any member.

With Python 3, this example prints the metadata and reads result and completion events. Replace `/path/to/run` with that run's directory:

```sh
python3 - /path/to/run <<'PYTHON'
import json
import sys
from pathlib import Path

run_dir = Path(sys.argv[1])
print(json.dumps(json.loads((run_dir / "run.json").read_text()), indent=2))
for line in (run_dir / "events.jsonl").read_text().splitlines():
    envelope = json.loads(line)
    event = envelope["event"]
    if event.get("type") in {"result", "run.end"}:
        print(json.dumps(envelope))
PYTHON
```

Use this example on a finished run; a live file can end with a line still being written. For live processing, use the runner's [`--json` stream](../running/experiments.md#how-do-i-inspect-the-result). Preserve the envelope's run ID and sequence number when combining records. Other event types contain model calls, progress, logs and experiment-specific observations.

The [file reference](../reference/layout.md) and [event reference](../reference/events.md) define the fields. Check completion, errors and the evidence behind summary metrics before using a result in an analysis; matching condition IDs alone do not establish scientific comparability.
