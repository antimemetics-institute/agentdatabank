# Run files and identity

The local store keeps conditions, run metadata, the event stream and working files as ordinary files.

## Where are runs saved?

Terminal experiments, browser tools, and verifier run-ID lookup use `--data-dir DIR`, then `ADB_DATA_DIR`, then `$XDG_DATA_HOME/adb`, with `XDG_DATA_HOME` defaulting to `~/.local/share`.

```text
DATA_DIR/
  conditions/
    CONDITION_ID-EXPERIMENT.json
  runs/
    CONDITION_ID-EXPERIMENT/
      RUN_ID/
        run.json
        events.jsonl
        workspace/
```

| Path | Contents |
| --- | --- |
| `conditions/CONDITION_ID-EXPERIMENT.json` | `{experiment, source, params}` for the condition, written once. |
| `run.json` | Runner index card: copied facts, lifecycle state and a derived cache. Replaced atomically at each heartbeat and at run end. |
| `events.jsonl` | One stream per run: event envelopes, one JSON object per line, in ascending sequence order. |
| `workspace/` | Fresh working directory used to execute the experiment. |

Readers derive `runs/<condition>-<experiment>/` and
`conditions/<condition>-<experiment>.json` from the recorded `(condition,
experiment)` pair. The experiment suffix is never parsed to recover either
field; discovery reads `run.json`. Experiment names may themselves contain
hyphens.

Readers accept exactly `events.jsonl`. Records are addressed by `(run, seq)`. The runner flushes each event line, so another process can inspect a live run. Files from failed and interrupted runs remain in the store.

The viewer reads schema exports once per run from the current build's manifests,
matching the envelope's experiment and schema version. It uses the current shared
export alone if that experiment version is unavailable. Schema files are not
written to run directories; updated hints also apply to older runs.
Render-review output goes to a caller-selected directory outside recorded runs.

## How is a condition ID calculated?

```text
condition_id = hex(sha256(JCS({experiment, source, params})))[:40]
```

JCS is RFC 8785 JSON canonicalization. The interface usually displays the first 12 characters of the condition ID. The hash uses values, not shell quoting or JSON object-key order.

`source` has the form `content:sha256:HASH`. Packaging computes it from the experiment's declared `src` paths plus shared package sources (`adb_events` and `adb_experiment` by default; Inspect programs add `adb_inspect`), imported into the Nix store after filtering development artifacts. The filtered names are `.venv`, `__pycache__`, `node_modules`, `dist`, `.direnv`, `.pytest_cache`, `.mypy_cache`, `.ruff_cache`, `result` and names beginning `result-`.

The identity excludes the runner, web, docs, and other undeclared paths. It also excludes the packaging `tree_hash`, fetch reference, platform, seed, credentials and endpoints. See [repeat and compare runs](../running/model.md) for the consequences.

Condition IDs are the first 40 lowercase hexadecimal characters of the SHA-256
hash (160 bits, matching the Nix store's hash width). The same ID is recorded in
`run.start.condition` and `run.json.identity.condition` and used in condition filenames
and run directory names. Hash truncation belongs only to `canonical.condition_id`;
readers use the recorded value.

A run ID has the form `yyyymmddthhmmssz-<12 lowercase hex random>`, for example
`20260916t120000z-012345abcdef`. The launching machine supplies the UTC clock
label and six random bytes. Validation accepts exactly
`[0-9]{8}t[0-9]{6}z-[0-9a-f]{12}`; the whole string is the ID everywhere.
The date is a launch-time label, not evidence of when work occurred or of clock
accuracy. Use capture timestamps and sequence numbers to interpret records.
Replicates of a condition share its condition ID and have separate run directories.

## What is in `run.json`?

The stream is evidence. The runner's index card is a cache of that stream plus
operational lifecycle state, used for listings and summaries. The stream wins
on disagreement; no experiment or replay uses the card as an input. Tests compare
its copies with `run.start` and recompute its derived block with `read_events`.

| Section | Fields and source |
| --- | --- |
| `identity` | `run`, `experiment`, `schema` from the start envelope; `condition` from `run.start`. |
| `inputs` | `params` and `seed`, copied exactly from `run.start`. |
| `lifecycle` | Runner-owned `state`; `started_at` is the start record's capture timestamp. At termination, `finished_at` is the end record's timestamp, and `duration_s` and `exit_code` copy `run.end`. |
| `provenance` | `source`, optional `fetch_ref` and `tree_hash`, and `runtime`, copied from `run.start`. |
| `definitions` | `results`: the ordered `run.start.result_definitions` list. |
| `derived` | Results, served models, usage, counts, latest status and last included event position, computed from written records. |

The seed is the derived run seed. The launcher uses a replicate ordinal to derive
it, but does not write that ordinal into the run. Persisted batch facts belong
only to the local jobs file.

Provenance includes runtime `platform`, `runner_python_version`, optional
`experiment_bin` and `runner_bin`, and `endpoints`. Executable paths are recorded
only under `/nix/store/`; endpoint values contain only `scheme://host[:port]`,
never userinfo, paths, query or fragment. A dirty or otherwise unpinned tree has
no `fetch_ref`. `tree_hash` is included only where the launcher can compute it;
absence carries no meaning. These copies do not include source code or build outputs.

`derived.served_models` is the sorted set of non-empty `llm.call.output.model`
values returned by the endpoints. The runs list shows these beside the requested
model when they differ; they do not change the condition identity.

`derived.results` is a map of the last result value per declared name. Undeclared
results stay in the stream but do not enter the map. `derived.usage` contains
`input_tokens` and `output_tokens`, summed across `llm.call` records; input totals
include cache reads and writes, which Inspect reports separately. Missing counts
contribute zero. `derived.counts` holds `llm_calls`, `failed_calls`, and the `by_kind` and
`llm_calls_by_agent` maps. The latter counts only `llm.call` records, keyed by
their recorded `agent`; calls without an agent still count toward `llm_calls`
but have no map entry. The runner reads only stream records to derive the card.
The viewer computes per-actor activity from loaded records and render hints on
the client, including custom events; that activity is not stored in the card.
`last_status` copies
the most recent status phrase when present; `last_seq` and `last_event_at` identify
the last included record. These are observed totals, not a provider bill.

The runner folds records only after writing them, refreshes the derived block
at every live heartbeat, and includes `run.end` in the final cache. The card is
replaced atomically, so concurrent readers see a complete snapshot. A hard crash
may leave a stale card; it never makes that card more authoritative than the stream.

## Published runs

Published runs use `events.jsonl.zst`, one object per run, uploaded with
`Content-Encoding: zstd` and `Content-Type: application/x-ndjson`. The same
condition/run directory structure lives under a version prefix, alongside
`index.jsonl` with one row per card. The workspace is local and never published.
Published objects for terminal runs are never rewritten; a new layout is a new
prefix produced from the records. Compression and future transport partitions
do not change `(run, seq)` record addresses.

In an `llm.call`, model API evidence is stored in `call.request` and
`call.response`; generation settings are read from the request. Inspect also saves every native
transcript event as `inspect.event` with its JSON-mode dump as custom data. Each
model event is immediately followed by the derived `llm.call`, even for cache
hits. Sample identity and cache notes use producer-prefixed metadata keys;
shared readers and web views treat those keys as opaque. Harness bookkeeping,
including generation config, remains available in the raw native record.

`run.start` omits the `experiment` field duplicated by its envelope and has no `dirty` flag. `run.json.identity` retains `experiment` because it is a standalone metadata file.

## What do the states mean?

| State | Meaning |
| --- | --- |
| `provisioning` | Run metadata has been created; the experiment has not yet reached the running state. |
| `running` | Runner is entering child-process execution; this state alone does not prove startup succeeded. |
| `completed` | Experiment process exited with code zero. |
| `failed` | Experiment process exited with a nonzero code. |
| `interrupted` | Runner handled an interrupt, or the experiment exited due to a signal. |

Terminal outcomes belong to `run.end`; `run.json.lifecycle.state` can contain any of the states above. Live stream state comes from the absence of `run.end` and the metadata heartbeat.

While active, the runner refreshes `run.json` approximately every ten seconds, including its derived block. The viewer uses the file's modification time as a heartbeat; no heartbeat timestamp is stored in the card. Its **interrupted?** label for stale active runs is display state; it is not written back as a terminal state. A hard crash can leave partial files and no `run.end`.
