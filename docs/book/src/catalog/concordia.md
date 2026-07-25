# Concordia

> [Concordia](https://github.com/google-deepmind/concordia) is DeepMind's library for generative agent-based modeling: LLM-driven characters improvise a social situation under a game master. In ADB it is one experiment whose params *are* the scenario — compose the cast, their goals, and the premise in the builder, and the run's event stream is the conversation itself.

The composer renders the `agents` roster as an editable table: one row per character, with a name, a goal, and an optional per-agent model override. Mixing models across the cast is a treatment axis — two different models negotiating is one command away.

## Running

The prefilled scenario is keyless — two old friends catching up, on `mock/model` (deterministic scripted lines, offline):

```console
$ nix run .#concordia -- \
    --set 'agents=[{"goal":"Catch up warmly and find out how Bob has been.","model":"","name":"Alice"},{"goal":"Share what has changed in your life since you last met.","model":"","name":"Bob"}]' \
    --set 'premise=Alice and Bob, old friends who have not spoken in months, run into each other at a small cafe on a rainy afternoon.' \
    --set game_master=dialogic \
    --set max_steps=6 \
    --set model=mock/model \
    --set temperature=0.5 \
    --set max_tokens=256
```

Every param is on the command line — [experiments have no defaults](../running/cli.md#every-param-is-on-the-command-line) — so the roster travels inside the command, and the command is the complete scenario. Compose it in the builder rather than hand-writing the JSON. A different cast is just different params; for example, a buyer and a seller with opposed goals and a zone of agreement:

```console
$ nix run .#concordia -- \
    --set 'agents=[{"goal":"Sell the bicycle for as high a price as you can, above $60.","model":"","name":"Mira"},{"goal":"Buy the bicycle as cheaply as you can, below $90.","model":"","name":"Tom"}]' \
    --set 'premise=At a busy street market, Mira is selling a used bicycle and Tom has stopped to look at it. They begin to discuss the price.' \
    --set game_master=dialogic \
    --set max_steps=4 \
    --set model=mock/model \
    --set temperature=0.5 \
    --set max_tokens=256
```

For a real model, use `openai/<served-name>` — the client speaks the OpenAI `/chat/completions` protocol, so any compatible server works (llama.cpp, vLLM, ollama, api.openai.com itself). Configure the credential set once — see [Credentials](../running/secrets.md).

The transcript streams live — the premise, then one `message` per agent turn, with every `llm.call` attributed to the agent that made it. Watch it in the [web GUI](../running/web.md):

```text
game_master: Alice and Bob, old friends who have not spoken in months, run into
             each other at a small cafe on a rainy afternoon.
Alice: Interesting — I hadn't thought of it that way.
Bob: I understand. Things have been much the same on my end.
```

## Parameters

| Param | Type | Form prefill | Notes |
|---|---|---|---|
| `agents` | `list(struct)` | the cafe cast | One row per character: `name`, `goal`, and a per-agent `model` override (empty = use `model`). At least 2 rows. |
| `premise` | `str` | the cafe scene | The opening situation the game master narrates. |
| `game_master` | `str` | `dialogic` | Any prefab under `concordia.prefabs.game_master`; `dialogic` is pure conversation, `generic` narrates events. |
| `max_steps` | `int` | `6` | One agent turn per step; with two agents, the number of messages in the conversation. |
| `model` | `llm` | `mock/model` | Drives the game master and every agent without an override. |
| `temperature` | `float` | `0.5` | Real backend only; the mock ignores it. |
| `max_tokens` | `int` | `256` | Per-call completion budget; real backend only. |

Two runs with the same cast, premise, and settings land in the same condition bucket, wherever they ran — the scenario is fully specified by the params, so replication is copying the command. Reuse a spelling exactly (the ones above, or a colleague's) and your samples pool with theirs.

## Results

| Result | Meaning |
|---|---|
| `status` | `completed` / `error` — a simulation that fails mid-run is data, not a crash. |
| `steps` | Steps actually run; a healthy run uses its whole `max_steps` budget. |
| `agents` | Roster size. |
| `world_events` | World-channel messages: the premise plus every agent turn. |
| `model_calls` | `llm.call` events — several per turn (the game master reasons too). |

## Notes

- **Determinism**: for a given seed, a mock run is byte-stable — the seed feeds the mock backend, Concordia's thread fan-out is forced serial, and the memory embedder is a hash. Real-model runs pass the seed to the server, but reproducibility ends where the provider's sampling begins; draw more samples instead (`--replicates`).
- **Concordia is a harness, not an experiment**: the exact `gdm-concordia` version is recorded per run as a provenance covariate, never part of the condition — see [Experiments, conditions, runs](../running/model.md).
- **Reasoning models**: the client disables thinking for qwen served names and strips stray `<think>` blocks so turns don't come back empty; the raw reply is still recorded verbatim in the `llm.call` event.
