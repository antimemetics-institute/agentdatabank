# GovSim documentation recording cache

This scripts-only hook captures a real GovSim adapter's synchronous OpenAI SDK
Chat Completions calls. It does not change request settings, messages, models,
embedder behavior, or the runner's source provenance. The cache contains full
effective SDK keyword arguments and the JSON SDK response, including model,
finish reason, and usage. It never captures HTTP headers or credentials.
Keep the raw run directory alongside the cache as the authoritative real run.

Build `exec.govsim` normally first. Then invoke its normal runner arguments
through the wrapper (paths are supplied by the caller):

```sh
node scripts/docs-gif/govsim-cache.mjs \
  --mode record --cache "$CACHE_DIR/govsim-astra.jsonl" \
  --work-dir "$CACHE_DIR/record-wrapper" --exec "$BUILT_EXEC" \
  -- --profile openai=docs --seed 42 \
  --set model=openai/gpt-6-astra \
  --set experiment=fish_baseline_concurrent \
  --set max_rounds=1 --set embedder=mxbai \
  --set temperature=null --set top_p=null \
  --set reasoning_effort=low --set max_tokens=8000
```

Use the saved `openai.docs` profile, `model=openai/gpt-6-astra`,
`experiment=fish_baseline_concurrent`, `max_rounds=1`, and `embedder=mxbai` in
the normal runner arguments. Model compatibility belongs to the adapter;
this hook does not silently remove unsupported generation parameters.
The parent cache directory must already exist. Cache and wrapper files are
created exclusively: repeating a recording against the same paths fails.
Each successful response is flushed and fsynced immediately. A failed run can
leave a partial cache; preserve it and inspect the raw run before any retry.

For replay, use `--mode replay` with the same cache and a fresh `--work-dir`.
Use the identical simulation configuration and built executable. The same
base seed is required too: keep `--seed 42` in both commands, since the runner
otherwise chooses a random base seed. Save replay runs to a different `--out`
directory from the real capture.
Identical requests consume responses in recorded occurrence order. Changed generation
parameters or messages, extra calls, and exhausted entries fail with no live
fallback. Python SDK responses are reconstructed as real `ChatCompletion`
objects. HTTP and socket connections are disabled in the child adapter;
Hugging Face and Transformers run offline. The mxbai weights must be available
locally. The runner itself retains its normal behavior.

Replay output retains the requested model and historical response metadata,
but is an offline reproduction, not a fresh Astra execution. Label replay media
explicitly and keep it separate from the original raw run. The wrapper prints
its mode on adapter stderr. No existing media scripts are modified.

The hook supports synchronous, non-streaming Chat Completions only. It does not
retry failed provider calls, record failed responses, guarantee determinism of
GovSim, or verify every cached response was consumed. If a simulation diverges,
replay stops instead of synthesizing or purchasing an answer. SDK request data
and responses may contain experiment prompts; do not publish a cache blindly.

For diagnosis, optionally supply `--miss-file FILE`. On the first cache miss,
the exact unmatched request is written to that new file with mode 0600. A cache
miss terminates the adapter with exit code 86, bypassing upstream error handlers
that can otherwise mask the failure. Check the run's terminal phase: the runner
CLI itself may return zero even when the adapter failed.

Known GovSim limitation: upstream memory retrieval deduplicates `Node` objects
using a Python set and then sorts only by creation time. Nodes use identity
hashes, so equal-time memories can appear in a different order between processes,
even with the same simulation seed. A real one-round recording reproduced this:
replay matched the initial calls, then failed because a prompt's memories were
reordered. Exact matching intentionally rejects that request. For reliable GIF
reuse, render the saved original event stream and identify it as a historical
capture; do not reorder prompts or substitute approximately matching responses.

Run focused tests offline:

```sh
python3 -m unittest discover -s scripts/docs-gif/govsim-cache
```
