# Running experiments

Every `nix run .#<experiment>` invocation is really the shared **`adb-runner`** wrapping that experiment. This page is the workflow — how to build a command, run it, and watch it. For the flag-by-flag list, see the [CLI reference](../reference/cli.md).

## Every param is on the command line

Experiments have no defaults. A manifest carries an `initial` value per param, but it only prefills the composer form and the suggested command — it never silently enters a run. So the oneliner you copy is the *complete* condition spec: paste it into a paper and it means the same thing forever, no matter what the suggested values later become.

The flip side: a bare `nix run .#<experiment>` refuses to run — and prints the fully-filled command to start from:

```console
$ nix run .#inspect-hello
adb: error: every param must be bound explicitly; missing ['epochs', 'generate_args', 'limit', 'model']
adb: bind every param on the command line — e.g.: nix run .#inspect-hello -- --set epochs=1 --set 'generate_args={}' --set limit=0 --set model=mockllm/model
```

## Don't hand-write commands — generate them

The fastest way to build a run command is the **web GUI composer**: it renders a form from the experiment's schema and regenerates the complete `nix run … -- --set …` one-liner as you edit. Copy the one-liner and paste it into a terminal.

```bash
nix run .#adb-web
```

See [The web GUI](web.md). Hand-writing works too; the composer and the CLI produce and accept the same commands.

## The workflow

**Inspect the schema** — what params and results does an experiment have?

```bash
nix run .#impossiblebench-livecodebench -- \
  --describe
```

`--describe` prints the manifest (param schema, initial values, results) as JSON — the same JSON the GUI renders a form from.

**Preview** — resolve params and print the condition hash without running anything:

```bash
nix run .#impossiblebench-livecodebench -- \
  --dry-run \
  --set model=anthropic/claude-sonnet-4-5-20250929 \
  --set split=conflicting \
  --set agent_type=minimal \
  --set max_attempts=3 \
  --set message_limit=30 \
  --set allow_test_modifications=true \
  --set limit=10 \
  --set epochs=1 \
  --set 'generate_args={}'
```

**Run it** — the same command without `--dry-run`. The runner prints a link into the live viewer for each run; start `adb-web` in another terminal and rows appear as events stream in. See [The web GUI](web.md).

**Headless** — for CI or piping, `--json` replaces the human log with the raw event stream on stdout:

```bash
nix run .#inspect-hello -- \
  --set model=mockllm/model \
  --set limit=0 \
  --set epochs=1 \
  --set 'task_args={}' \
  --set 'generate_args={}' \
  --json | jq 'select(.type=="metric")'
```

## The core knobs

| You want to… | Use | More |
|---|---|---|
| set a parameter | `--set KEY=VALUE` (JSON or `@file`) | [the catalog](../catalog/impossiblebench.md) |
| draw more samples | `--replicates N` | |
| fix the seed | `--seed N` | |
| run a real model | (configure a provider first) | [Secrets](secrets.md) |

Values are parsed as JSON when they look like it, else as strings — `--set limit=20` and `--set model=openai/gpt-4o` both do what they say; `--set task_args=@args.json` reads a file. Repeating `--set` for the same param: later wins.

`--replicates N` runs the same condition N times, back to back — N samples in the same bucket, each with its own run id.

## Exit behavior

- Exit `0` on a completed invocation (individual run failures are counted, not fatal).
- Exit `2` on a usage or schema error (unbound param, unknown param, unconfigured provider).
- `Ctrl-C` marks in-flight runs `interrupted`; partial events already on disk are kept.
