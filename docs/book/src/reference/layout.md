# Run directory layout

The runner writes everything under `$ADB_HOME` (default `$XDG_DATA_HOME/adb`, else `~/.local/share/adb`).

```
$ADB_HOME/
  conditions/
    <condition_id>.json        # the spec as written, one per condition (write-once)
  runs/
    <condition_id>/            # runs grouped under their condition
      <run_id>/                # run_id is a ULID
        run.json               # the run record; rewritten atomically on transitions;
                               #   its mtime is the ~10s liveness heartbeat
        events-00001.jsonl     # event stream, chunked at ~1,000,000 bytes
        events-00002.jsonl     #   (events-NNNNN.jsonl, 5-digit, zero-padded, from 1)
        artifacts/             # files the experiment declared via `artifact` events
        workspace/             # the run's working directory (cwd for the experiment)
```

## Notes

- **`conditions/<cid>.json`** is written **once** per condition (skipped if it exists) and holds the spec *as written*. It is stored at the top level, not inside each run.
- **`run.json`** is written atomically (temp file + replace, `indent=2, sort_keys=True`). It holds the params, `source` (content identity), `fetch_ref` (reproducibility rev) + `dirty`, env fingerprint, seed, and status. Its **mtime is touched every ~10s while the run is alive** — the heartbeat the GUI uses to distinguish a live `running` run from an `interrupted?` one.
- **`events-NNNNN.jsonl`** roll to a new chunk when the next line would exceed ~1 MB. One compact JSON object per line.
- **`artifacts/`** holds whatever the experiment writes and declares. Chat / llm-call views are never written here (or anywhere in the run tree) — they are **projections of the stream**, rendered on demand by the GUI.
- **`workspace/`** is the experiment's cwd; the GUI never reads it.

## Finding a run by id

Run ULIDs are globally unique but stored under their condition, so the GUI's bare-id route (`#/runs/<rid>`) resolves by globbing `runs/*/<run_id>`.

## What the GUI reads

The web server reads only `run.json`, `events-*.jsonl`, and `conditions/<cid>.json`, and derives params from conditions. Bulky event fields (`request.messages`, `response.raw`, strings over ~4 KB) are served as elided markers with the disk record left untouched — the full value is fetched on demand via per-event endpoints.
