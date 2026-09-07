# GovSim

In-tree port of the GovSim adapter at commit
`f3b028b14bce693c69936544685bf199f9f4f71d`.
The original external ADB development scaffold is replaced by this repository's
Python libraries and automatic experiment registration. The local Python package
`govsim_adapter/` contains the ADB integration; the upstream GovSim checkout is
fetched separately at the pinned revision below. The experiment and command
remain named `govsim`.

The scientific source is [GovSim](https://github.com/giorgiopiatti/GovSim),
*Cooperate or Collapse: Emergence of Sustainable Cooperation in a Society of LLM
Agents* (Piatti et al., NeurIPS 2024, https://arxiv.org/abs/2404.16698).
GovSim runs verbatim at `1d11adf047b24fa2ba0d44a1d4931015ea2e5210`, with
PathFinder at `69b8d646ad3e618380dd0d47ec4d1e8d2d4c930e`. All 17 upstream
fishing, sheep, and pollution configurations are exposed, including baseline,
universalization, no-language, outsider, and fishing paraphrase treatments.

Run the keyless integration path from the repository root:

```sh
$(nix-build --no-out-link -A exec.govsim) \
  --set experiment=fish_baseline_concurrent --set max_rounds=1 \
  --set model=mock/model --set embedder=hash \
  --set temperature=0.0 --set top_p=1.0 --set max_tokens=8000 \
  --set reasoning_effort=null
```

`max_rounds=0` keeps upstream's cap (12 or 15). Live provider/model IDs use
ADB's credential routing through `adb_experiment.ChatClient`; no credentials
are parameters or saved in configuration. `top_p` is forwarded, temperature
is applied uniformly, and `max_tokens` caps each completion. The original
upstream parsing/default-value fallback remains intact.

Set `temperature=null` and `top_p=null` to omit sampling fields from every
request, including upstream operations that substitute their own defaults.
`reasoning_effort` accepts `low`, `medium`, `high`, `xhigh`, or `max`; `null`
omits it and keeps the provider default. For Astra, use both sampling fields
as `null` and `reasoning_effort=low`, following the
[official model guide](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6-astra).
These choices are recorded in the effective configuration and provenance.

The mock uses scripted modest harvests; it validates the actual upstream
simulation and adapter, and is not a scientific model result. The default
`hash` embedder is artificial: semantic relevance becomes hash noise. `mxbai`
uses upstream's `mixedbread-ai/mxbai-embed-large-v1` CPU embedder and may download
roughly 1.3 GB. Upstream does not pin its HuggingFace revision, so those weights
remain mutable. Neither path is claimed as a paper reproduction. Dependencies
are CPU-only Torch, Transformers, Sentence Transformers, Hydra, pandas,
PettingZoo, WandB (disabled), and PathFinder, locked in `uv.lock`.

Each run emits instrumented model calls, live resource state and pool metrics,
and a conversation transcript replayed after completion (timestamps are replay
time). Artifacts include the upstream `log_env.json`, effective `config.yaml`,
and `provenance.json` recording source revisions, effective model/generation
parameters, embedder choice, and the derived 32-bit seed. NumPy requires the
runner's replicate seed to be reduced to 32 bits.

Survival, gains, and equality follow the source analysis formulas with a
zero-sum Gini guard. `over_usage` is the adapter's reconstruction: the fraction
of actions wanting more than `(pool_before // 2) // harvesters_that_round`.
For outsider treatments this differs from upstream's internally fixed agent
count. Scientific interpretation must account for this difference.

Tests: `cd experiments/govsim && uv run -q pytest -q`. Integration tests use
`GOVSIM_UPSTREAM` to point to the pinned checkout; unit tests need no downloads
or API calls after installing the locked dependencies.

Treatments use the upstream prompts and scheduling unchanged:

- Baseline: concurrent harvests, observation of others' catches, group discussion,
  then reflection, normally for 12 rounds.
- Universalization: an extra memory asks agents to consider everyone acting alike.
- Paraphrase 1/2: fishing baseline with reworded system prompts.
- No language: removes group discussion and observation of others' catches.
- Outsider: four initial agents; a profit maximizer joins at round 3, with a
  15-round cap. An additional variant applies universalization as well.

Upstream's MIT license is retained in `UPSTREAM_LICENSE`; the fetched checkout
also retains its original license. The metrics implementation attributes the
source analysis formulas in `govsim_adapter/metrics.py`.
