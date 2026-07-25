# inspect_evals tasks

> Classic eval benchmarks from the [`inspect_evals`](https://github.com/UKGovernmentBEIS/inspect_evals) catalog — plus the bundled keyless `hello` smoke test — one experiment per task.

Each task is its own experiment; there is no `task` parameter. The experiment list is generated from the pinned upstream catalog (about 180 experiments). A few examples:

| Experiment | Task | Needs |
|---|---|---|
| `inspect-hello` | bundled `hello` (2 instruction-following samples) | any model — your real one, or keyless/offline with `mockllm/model`; both deterministically score `1.0` |
| `inspect-gsm8k` | `inspect_evals/gsm8k` (grade-school math) | a [provider](../running/secrets.md) + network |
| `inspect-gpqa-diamond` | `inspect_evals/gpqa_diamond` (graduate-level science MCQ) | a [provider](../running/secrets.md) + network |
| `inspect-swe-bench-verified-mini` … | agentic tasks whose eval declares a sandbox | the above + docker on the host |

Tasks whose eval needs an extra pip dependency (`gaia`, `agentdojo`, …) are catalogued but not yet runnable. The full list is the overview page in the [web GUI](../running/web.md), or `nix flake show`.

```console
$ nix run .#inspect-hello -- \
    --set model=mockllm/model \
    --set limit=0 \
    --set epochs=1 \
    --set 'generate_args={}'

$ nix run .#inspect-gsm8k -- \
    --set model=anthropic/claude-sonnet-4-5-20250929 \
    --set limit=20 \
    --set epochs=1 \
    --set fewshot=10 \
    --set fewshot_seed=42 \
    --set shuffle_fewshot=true \
    --set 'generate_args={}'
```

Every param is on the command line — [experiments have no defaults](../running/cli.md#every-param-is-on-the-command-line). Copy commands from the composer, or run bare and copy the suggested command it prints.

Real tasks download their datasets from HuggingFace on first run. `inspect-hello` bundles its samples and stays offline — it exists so your first run (and any CI check) exercises the whole pipeline with zero setup.

## Parameters

A task's own arguments are real typed params, taken from the task function's signature — `inspect-gsm8k` has `fewshot`, `fewshot_seed`, `shuffle_fewshot`; other tasks have their own. Upstream defaults prefill the form, and a kwarg whose upstream default is `None` becomes a *nullable* param bound explicitly as `--set name=null` — the oneliner always states every value, so an upstream default change can never silently reinterpret it. A task kwarg that shares a family param's name (`seed`, `limit`, …) appears prefixed, as `task_seed` etc.

The form lists the task's params first (they're the condition's substance), then model, then the inspect harness knobs:

| Param | Type | Form prefill | Notes |
|---|---|---|---|
| *per-task params* | *typed* | *the task's own defaults* | e.g. `fewshot` on `inspect-gsm8k`; `null` where upstream declares `None`. |
| `model` | `llm` | `mockllm/model` for `inspect-hello`; none elsewhere | Inspect model id (`openai/…`, `anthropic/…`); the prefix also keys [credential injection](../running/secrets.md). Real tasks have no prefilled model — the canonical condition is always something you chose. |
| `limit` | `int` | `0` | Sample cap; `0` = the whole dataset. |
| `epochs` | `int` | `1` | Passes over the dataset. |
| `generate_args` | `object` | `{}` | Generation overrides, rendered as a typed form (temperature, max_tokens, reasoning_effort, …). A field left unset keeps the provider's default. |

## Results

The standard inspect-family results: `status`, `samples`, `completed`, `errors`, `score`, `score_name`, `tokens_input`, `tokens_output`.

## Identity

The experiment name is part of the [condition hash](../running/model.md), so tasks never collide. All the tasks share one pinned upstream package, so updating that pin re-versions the family together. Every run records the exact `inspect_ai`/`inspect_evals` versions, task version, and dataset identity, so buckets that a version boundary didn't really change can be pooled at read time — and genuine breaks flagged — later. See [ImpossibleBench](impossiblebench.md#how-families-work) for how families sit on the shared wrapper.
