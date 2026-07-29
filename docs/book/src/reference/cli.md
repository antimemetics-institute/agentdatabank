# CLI reference

A single lookup page for every command surface. See [Running experiments](../running/cli.md) for prose.

## Flake apps & packages

| Invocation | Kind | What |
|---|---|---|
| `nix run .#<experiment> -- …` | app | Run an experiment (`inspect-hello`, `inspect-gsm8k`, `inspect-gpqa-diamond`, `impossiblebench-livecodebench`, `impossiblebench-swebench`). |
| `nix run .#adb-runner -- credentials …` | app | Manage local credential sets. |
| `nix run .#adb-web -- [--host ADDR] [--port N] [--home DIR] [--no-open]` | app | The local web GUI (default `127.0.0.1:8340`). |
| `.#manifests` | package | All experiment schema JSONs, aggregated (drives the GUI's builder). |

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

## Environment variables

| Var | Used by | Meaning |
|---|---|---|
| `ADB_HOME` | runner, web | Run store root (default `~/.local/share/adb`). |
| `ADB_CREDENTIALS_FILE` | runner | Override the credential store path (CI materializes this file). |
| `ADB_PREFERENCES_FILE` | runner | Override the per-experiment profile-choice file (names only, not secret). |
| `ADB_HOST` / `ADB_PORT` / `ADB_NO_OPEN` | web | Fallbacks for `--host` / `--port` / `--no-open` (flags win). |
| `ADB_WEB_STATIC` | web | Built-frontend dir (unset → API-only). |
| `ADB_WEB_MANIFESTS` | web | Manifests dir for the run-config builder. |
| `ADB_RUN_ID` / `ADB_RUN_DIR` / `ADB_SEED` | experiment | Set by the runner in the child env. |

There is **no env passthrough** into experiments: a run's environment is constructed — system basics (`PATH`, `HOME`, locale), [deliberately injected credentials](../running/secrets.md#how-credentials-reach-the-experiment), and the `ADB_*` run vars — and recorded per run with credential values ablated.
