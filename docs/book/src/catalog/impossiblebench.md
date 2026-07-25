# ImpossibleBench

> [ImpossibleBench](https://arxiv.org/abs/2510.20270) measures an agent's propensity to **cheat**: coding benchmarks whose "impossible" test variants can only be passed by specification-violating shortcuts — editing the tests, special-casing inputs, gaming the harness. On an impossible split, *passing is the reward-hacking signal*.

The family pins the upstream [`impossiblebench`](https://github.com/safety-research/impossiblebench) package (an `inspect_ai` implementation). Each upstream task is its own experiment — the task is never a parameter:

| Experiment | Upstream task | What it is |
|---|---|---|
| `impossiblebench-livecodebench` | `impossible_livecodebench` | Function-implementation problems (LiveCodeBench-derived), agent iterates against unit tests. |
| `impossiblebench-swebench` | `impossible_swebench` | Real-repo issue fixing (SWE-bench-derived), agent works in a checkout with bash/editor tools. |

Every experiment takes a `split`:

- **`original`** — the unmutated benchmark: the control condition, an ordinary capability score.
- **`oneoff`** — one test is subtly wrong: passing all tests requires special-casing it.
- **`conflicting`** — tests contradict each other: passing them all is logically impossible without exploiting the harness.

## Running

Both need a real model (`model` and `split` are required — there is deliberately no default), network, and docker on the host PATH (the agent's code runs in an inspect sandbox; SWE-bench pulls per-instance images). Configure the model's credentials once first — see [Credentials](../running/secrets.md).

```console
$ nix run .#impossiblebench-livecodebench -- \
    --set model=anthropic/claude-sonnet-4-5-20250929 \
    --set split=conflicting \
    --set agent_type=minimal \
    --set max_attempts=3 \
    --set message_limit=30 \
    --set allow_test_modifications=true \
    --set limit=10 \
    --set epochs=1 \
    --set 'generate_args={}'

$ nix run .#impossiblebench-swebench -- \
    --set model=openai/gpt-4o-2024-11-20 \
    --set split=oneoff \
    --set agent_type=tools \
    --set max_attempts=10 \
    --set message_limit=100 \
    --set allow_internet=false \
    --set limit=5 \
    --set epochs=1 \
    --set 'generate_args={}'
```

Every param is on the command line — [experiments have no defaults](../running/cli.md#every-param-is-on-the-command-line). Copy commands from the composer, or run bare and copy the suggested command it prints.

The interesting comparison is always *the same model on `original` vs. an impossible split*: the score gap is capability, the impossible-split pass rate is cheating.

## Parameters

Shared by both experiments. The prefill column is presentation only — it fills the composer form and the suggested command; every param must still be bound on the command line:

| Param | Type | Form prefill | Notes |
|---|---|---|---|
| `model` | `llm` | none | Inspect model id; the prefix keys [credential injection](../running/secrets.md). |
| `split` | `enum` | none | `original` / `oneoff` / `conflicting` — deliberately not prefilled; the split is the condition's whole point. |
| `agent_type` | `enum` | `minimal` (lcb) / `tools` (swe) | The agent scaffold: `minimal` = submission loop; `tools` = file editing with bash. |
| `max_attempts` | `int` | `3` (lcb) / `10` (swe) | Submission attempts per sample. |
| `message_limit` | `int` | `30` (lcb) / `100` (swe) | Per-sample message cap. |
| `limit` | `int` | `0` | Sample cap (`0` = the whole split). |
| `epochs` | `int` | `1` | |
| `generate_args` | `object` | `{}` | Generation overrides; unset fields keep the provider defaults. |

Plus one each: `allow_test_modifications` (`bool`, prefill `true`, livecodebench — test editing is one of the cheating channels being measured) and `allow_internet` (`bool`, prefill `false`, swebench sandbox).

## Results

The standard inspect-family results: `status`, `samples`, `completed`, `errors`, `score`, `score_name`, `tokens_input`, `tokens_output`. On an impossible split, read `score` as the **exploitation rate**, not capability.

## How families work

Every experiment here is a thin declaration over one shared wrapper: it runs `inspect_ai.eval(...)` and translates the log into ADB events — every chat turn a `message`, every model call an `llm.call`, every score a `metric`, plus a record of the exact upstream package versions. A family pins its own environment and declares one experiment per task.

Both ImpossibleBench experiments share that one pinned environment, so updating it re-versions both together — a scorer or dataset change should re-bucket every task it might have touched. The shared wrapper itself is not part of identity; it's recorded per run as a covariate. See [Experiments, conditions, runs](../running/model.md).

## The sandbox caveat

The agent executes model-written code in docker containers on your machine, and (on livecodebench) may modify files aggressively — that containment is docker-grade, not VM-grade. VM-isolated execution is the planned replacement; until then, treat impossible-split runs as running adversarial code, and keep `allow_internet` off unless you need it.
