# Run files and identity

The local store keeps conditions, run metadata, event chunks and artifacts as ordinary files.

## Where are runs saved?

The runner uses `--out DIR`, then `ADB_DATA_DIR`, then `$XDG_DATA_HOME/adb`, with `XDG_DATA_HOME` defaulting to `~/.local/share`. The viewer uses the same default and accepts `--data-dir DIR`.

```text
DATA_DIR/
  conditions/
    CONDITION_ID.json
  runs/
    CONDITION_ID/
      RUN_ID/
        run.json
        events-00001.jsonl
        events-00002.jsonl
        artifacts/
        workspace/
```

| Path | Contents |
| --- | --- |
| `conditions/CONDITION_ID.json` | `{experiment, source, params}` for the condition, written once. |
| `run.json` | Current or final run metadata. Replaced atomically as the run changes state. |
| `events-NNNNN.jsonl` | Event envelopes, one JSON object per line, in ascending sequence order. Chunks rotate at roughly one million characters. |
| `artifacts/` | Files deliberately retained by the experiment; artifact events point to run-relative paths. |
| `workspace/` | Fresh working directory used to execute the experiment. |

Read event files in numeric filename order. The runner flushes each event line, so another process can inspect a live run. Files from failed and interrupted runs remain in the store.

## How is a condition ID calculated?

```text
condition_id = sha256(JCS({experiment, source, params}))
```

JCS is RFC 8785 JSON canonicalization. IDs are full lowercase hexadecimal SHA-256 hashes; the interface usually displays the first 12 characters. The hash uses values, not shell quoting or JSON object-key order.

`source` has the form `content:sha256:HASH`. Packaging computes it from the experiment's declared `src` path or ordered list of paths, imported into the Nix store after filtering development artifacts. The filtered names are `.venv`, `__pycache__`, `node_modules`, `dist`, `.direnv`, `.pytest_cache`, `.mypy_cache`, `.ruff_cache`, `result` and names beginning `result-`.

The identity excludes source paths not declared by that experiment, including shared runner code unless explicitly included. It also excludes the fetch reference, platform, seed, replicate, credentials and endpoints. See [repeat and compare runs](../running/model.md) for the consequences.

A run ID is a newly generated ULID. Replicates of a condition share its condition ID and have separate run directories.

## What is in `run.json`?

| Field | Meaning |
| --- | --- |
| `run` | ULID identifying this execution. |
| `condition` | Full condition hash. |
| `experiment` | Experiment name. |
| `source` | Declared experiment content identity. |
| `fetch_ref` | Repository reference for fetching source, or a `dirty:` reference when no fetchable revision is recorded. |
| `dirty` | Whether `fetch_ref` starts with `dirty:`. |
| `seed` | Derived run seed, not the CLI base seed. |
| `replicate` | One-based replicate number within this invocation. |
| `state` | Current or terminal process state. |
| `started_at` | UTC timestamp written when the run begins. |
| `finished_at` | UTC completion timestamp; added at termination. |
| `duration_s` | Elapsed run duration in seconds; added at termination. |
| `summary` | Last emitted metric values for names declared in manifest `results`; added at termination. |
| `usage_totals` | `llm_calls`, `input_tokens`, `output_tokens` accumulated from `llm.call` events; added at termination. |
| `realized_params` | Parameters passed to the process; added at termination. Also present in `run.start`. |

Token totals use the usage the adapter reports; absent token counts contribute zero. `llm_calls` counts emitted call events, including calls with errors. These are recorded-event totals, not an independently verified provider bill.

## What do the states mean?

| State | Meaning |
| --- | --- |
| `provisioning` | Run metadata has been created; the experiment has not yet reached the running state. |
| `running` | Experiment process has started. |
| `completed` | Experiment process exited with code zero. |
| `failed` | Experiment process exited with a nonzero code. |
| `interrupted` | Runner handled an interrupt, or the experiment exited due to a signal. |

While active, the runner touches `run.json` approximately every ten seconds without changing its contents. The viewer uses that file modification time as a heartbeat. Its **interrupted?** label for stale active runs is display state; it is not written back as a terminal state. A hard crash can leave partial files and no `run.end`.
