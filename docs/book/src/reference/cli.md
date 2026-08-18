# CLI reference

A single lookup page for every command surface. See [Running experiments](../running/cli.md) for prose.

## Flake apps & packages

| Invocation | Kind | What |
|---|---|---|
| `nix run .#<experiment> -- …` | app | Run an experiment (`inspect-hello`, `inspect-gsm8k`, `inspect-gpqa-diamond`, `impossiblebench-livecodebench`, `impossiblebench-swebench`). |
| `nix run .#adb-runner -- credentials …` | app | Manage local credential sets. |
| `nix run .#adb-web -- [--host ADDR] [--port N] [--home DIR] [--no-open]` | app | The local web GUI (default `127.0.0.1:8340`). Serves and queues; executes nothing. |
| `nix run .#adb-worker -- […]` | app | A queue worker — claims and executes jobs. See [Running from the GUI](../running/workers.md). |
| `nix run .#adb-local` | app | adb-web + one worker, torn down together — the one-command local setup. |
| `.#manifests` | package | All experiment schema JSONs, aggregated (drives the GUI's builder). |
| `.#nixosModules.adb-worker` | module | Run a worker as a NixOS service (secrets as files via `LoadCredential`). |

## `adb-runner` (the experiment wrapper)

```
nix run .#<experiment> -- [options]
```

| Flag | Meaning |
|---|---|
| `--set KEY=VALUE` | Bind a param (JSON, string, or `@file`). Repeatable. **Every param must be bound** — experiments have no defaults; a bare invocation exits 2 and prints the suggested fully-bound command (from the manifest's `initial` values). |
| `--replicates N` | Runs to draw from this condition (default 1). |
| `--seed N` | Base seed (random if omitted; always recorded). |
| `--out DIR` | Override `$ADB_HOME`. |
| `--json` | Stream raw event JSONL to stdout (headless). |
| `--dry-run` | Print the resolved condition + hash; run nothing. |
| `--describe` | Print the manifest JSON and exit. |

Exit: `0` completed invocation (individual run failures counted, not fatal) · `2` usage/schema error · `Ctrl-C` → in-flight runs marked `interrupted`.

## `adb-runner credentials`

```
nix run .#adb-runner -- credentials <list|set|remove|path>
```

| Command | What |
|---|---|
| `list` | Show configured credential sets, one line per profile (secrets masked). |
| `set <name>[.<profile>]` | Add/update a set — every value is prompted, then a profile name (`Enter` = `default`); the dotted form targets a profile directly. Secrets hidden; there is no `KEY=VALUE` argv form: argv leaks into `ps`/history. Scripts pipe one line per prompt on stdin. |
| `remove <name>[.<profile>]` | Delete a set, or one profile of it. |
| `path` | Print the store file path. |

File: `~/.config/adb/credentials.toml` (0600); override with `$ADB_CREDENTIALS_FILE` (also the CI interface — materialize it from your pipeline's secret manager). Built-in names (`openai`, `anthropic`, `google`, `groq`, `mistral`, `grok`, `moonshotai`, `openrouter`, `azureai`) are prompt templates only; any other name is a named set (`<NAME>_API_KEY`/`<NAME>_BASE_URL`, reached by `openai-api/<name>/<model>` ids). An interactive run that needs an unconfigured set prompts for it inline. See [Credentials](../running/secrets.md).

## `adb-runner worker`

```
nix run .#adb-worker -- [--server URL] [--name NAME] [--repo SRC] [--token-file FILE] [--once]
```

Headless queue worker: registers with an adb-web queue (no `--server` → probes `127.0.0.1:8340`–`8343`), long-polls for jobs, builds `exec.<experiment>` from its one configured repo, runs it with `--json`, and reports run ids and progress back. Never prompts — credentials resolve from this machine's store by profile name. Prose and the NixOS module are in [Running from the GUI](../running/workers.md).

## Environment variables

| Var | Used by | Meaning |
|---|---|---|
| `ADB_HOME` | runner, web | Run store root (default `~/.local/share/adb`). |
| `ADB_CREDENTIALS_FILE` | runner | Override the credential store path (CI materializes this file). |
| `ADB_PREFERENCES_FILE` | runner | Override the per-experiment profile-choice file (names only, not secret). |
| `ADB_HOST` / `ADB_PORT` / `ADB_NO_OPEN` | web | Fallbacks for `--host` / `--port` / `--no-open` (flags win). |
| `ADB_WEB_STATIC` | web | Built-frontend dir (unset → API-only). |
| `ADB_WEB_MANIFESTS` | web | Manifests dir for the run-config builder. |
| `ADB_WEB_TOKEN` | web | Bearer token that admits non-loopback workers and job submitters. |
| `ADB_WORKER_REPO` | worker | Fallback for `--repo` (the `nix run .#adb-worker` wrapper bakes the pinned source). |
| `ADB_WORKER_TOKEN` | worker | Bearer token (fallback for `--token-file`). |
| `ADB_RUN_ID` / `ADB_RUN_DIR` / `ADB_SEED` | experiment | Set by the runner in the child env. |

There is **no env passthrough** into experiments: a run's environment is constructed — system basics (`PATH`, `HOME`, locale), [deliberately injected credentials](../running/secrets.md#how-credentials-reach-the-experiment), and the `ADB_*` run vars — and recorded per run with credential values ablated.
