# Saved-run recording adapter

`replay-build.mjs` is a recording-only `ADB_WORKER_BUILD` hook. Configure:

- `ADB_DOCS_REPLAY_RUN`: absolute path to a completed saved run containing `run.json`, `events.jsonl`, and referenced artifacts.
- `ADB_DOCS_REPLAY_DIR`: isolated directory for generated wrappers and private manifests.
- `ADB_DOCS_REPLAY_SPEED`: positive playback multiplier (default `1`).

The hook accepts the worker's ordinary `nix-build` arguments ending in `exec.EXPERIMENT` and prints an executable path. It builds only the manifests and normal ADB runner, never the experiment runtime. The returned executable accepts normal runner arguments. Captured parameter values must match exactly. Parameters added since the capture must use their current manifest's initial values; these are recorded separately as `added_defaults` in replay provenance.

`bash scripts/docs-clips.sh --replay-run /path/to/run` regenerates all four README GIFs and their light/dark documentation videos. The browser uses the capture's model and parameter values. The credential demonstration currently requires an OpenAI model with null `temperature` and `top_p`.

The private execution manifest changes `llm` parameter kinds to `str` and the wrapper discards `--credential` selections. This bypasses credential provisioning only for recording, retaining captured model values in run metadata. No model SDK, model installation, or credentials are needed. The replay adapter uses Python's standard library and does not execute experiment code or make network calls. Building the runner/manifests can use Nix's normal caches/network.

`replay.py` reads ordered envelopes, waits timestamp deltas divided by speed, and emits original payloads. Recorded `run.*` events are suppressed; the real runner assigns new IDs, timestamps, sequences, and lifecycle events. Original usage and model-call counts describe historical calls, not new paid calls. Only completed captures are accepted.

Referenced artifacts are copied with source/destination containment checks, including symlink resolution. Runner-owned metadata cannot be overwritten. The original run stays untouched. New runs have a `dirty:docs-recording-replay:…` source and an `artifacts/docs-recording-replay.json` artifact recording original metadata, capture/artifact SHA-256 hashes, and playback speed. Do not treat these recordings as new experimental observations.

Run offline checks with:

```sh
python3 -m unittest discover -s scripts/docs-gif -p 'test_replay.py'
```
