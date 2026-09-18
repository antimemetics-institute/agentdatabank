# Commands and settings

Run an experiment through its named app, such as `nix run .#inspect-hello -- ...`.
This is a generated launcher that supplies the manifest, source identity, and
program path before starting the runner internally. Do not invoke `adb-runner`
or the underlying experiment program directly to execute an experiment.
ADB's management tools use `adb-` names. Commands below follow the book's [Nix settings](../running/nix.md).

## Experiment options

```sh
nix run .#inspect-hello -- --help
```

Pass these options to the named experiment app:

| Option | Meaning |
| --- | --- |
| `--set KEY=VALUE` | Bind an experiment parameter. Repeat for every declared parameter. A later binding of the same key wins. |
| `--replicates N` | Number of runs in this invocation; default `1`. Use a positive integer. Runs execute sequentially. |
| `--seed INTEGER` | Base seed used to derive per-run seeds. A random 32-bit base seed is chosen when omitted. |
| `--profile SET=PROFILE` | Select a saved profile for a credential set used by this run. Repeat for multiple sets. |
| `--data-dir DIR` | Write runs to this data directory, overriding `ADB_DATA_DIR`. |
| `--json` | Print each recorded event, including its run metadata, to stdout as one JSON line as it happens. Events are also saved normally; diagnostics go to stderr. |
| `--non-interactive` | Never prompt for input. Fail if required credentials or profile selections cannot be resolved automatically. Non-terminal stdin also disables prompts. |
| `--dry-run` | Print resolved inputs, condition ID, base seed and replicate count; do not execute or resolve credentials. Checks parameter names and types; list-length bounds are checked when executing. |
| `--describe` | Print the experiment manifest as JSON and exit without requiring parameter bindings. |
| `-h`, `--help` | Print usage. |

The runner returns exit code `2` for input or credential-resolution errors handled before execution. After execution it reports state counts and returns `0` if all runs completed, `1` if any run failed or timed out, or `130` if interrupted. An interruption stops the remaining replicates. Inspect `run.end` or saved `run.json` states for individual process outcomes, and summaries and events for evaluation results.

## How are parameter values read?

The value after `=` is parsed as JSON if possible, otherwise as a string. `@path` reads the file and applies the same JSON-or-text rule. Text-file contents are kept as the string value. A malformed value or file beginning with `[` or `{` is rejected rather than treated as a string.

| Argument | Bound value |
| --- | --- |
| `--set count=3` | Integer `3` |
| `--set enabled=true` | Boolean `true` |
| `--set label=trial` | String `"trial"` |
| `--set 'label="3"'` | String `"3"` |
| `--set 'names=["Ada","Lin"]'` | JSON array |
| `--set 'options={"temperature":0.2}'` | JSON object |
| `--set optional=null` | Null; accepted only if the declaration is nullable |
| `--set options=@options.json` | JSON or text read from the named file |

These are syntax examples; the keys must exist in the selected experiment. Unknown keys, omitted parameters and type mismatches are errors. Shell quoting is separate from JSON syntax: quote arguments containing spaces, braces or other shell punctuation.

## Credential commands

Credential management is a standalone use of `adb-runner`; these commands
configure profiles and do not execute experiments:

```sh
nix run .#adb-runner -- credentials --help
```

| Subcommand | Meaning |
| --- | --- |
| `list` | Show configured sets and profiles with secrets masked. |
| `list --json` | Return machine-readable inventory, templates and masked profile contents; secret presence is represented by `true`. |
| `set SET[.PROFILE]` | Prompt for values and save a profile; an undotted set prompts for the profile name. |
| `set SET[.PROFILE] --json` | Read one environment-variable-to-value JSON object on stdin. Strings set fields; empty/absent values keep existing fields; null deletes a field. Defaults to profile `default` if omitted. |
| `remove SET[.PROFILE]` | Delete a whole set or one profile. |
| `remember EXPERIMENT SET PROFILE` | Save the existing profile as that experiment's choice for this set. |
| `path` | Print the credential store path. |

Profile names start with a lowercase letter or digit and continue with lowercase letters, digits, `_` or `-`. `new` is reserved. See [credential setup](../running/secrets.md) for selection order and model-ID routing.

## Data and configuration settings

Experiment launchers, `adb-local`, `adb-web`, and `adb-runner verify` select run
storage in this order: `--data-dir DIR`, `ADB_DATA_DIR`, then `$XDG_DATA_HOME/adb`
(or `~/.local/share/adb` when `XDG_DATA_HOME` is unset). Commands copied from the
web include its selected directory explicitly.

To audit a saved run by ID, use `nix run .#adb-runner -- verify RUN_ID --data-dir DIR`.
`verify` also accepts a run-directory path directly; see [run auditing](../running/model.md#how-do-i-audit-the-first-real-run).

| Setting | Effect |
| --- | --- |
| `ADB_DATA_DIR` | Default root for run data; overridden by `--data-dir`. |
| `XDG_DATA_HOME` | When `ADB_DATA_DIR` is absent, data lives under this directory's `adb/`; default `~/.local/share`. |
| `ADB_CREDENTIALS_FILE` | Override the credential TOML path. |
| `XDG_CONFIG_HOME` | Base for `adb/credentials.toml` and `adb/preferences.toml`; default `~/.config`. The credential-file override does not relocate preferences. |
| `NO_COLOR` | Disable runner terminal color. Nonterminal stderr and `TERM=dumb` also disable it. |
| `DOCKER_HOST` | Forwarded to the experiment for Docker-backed tasks. The required daemon must be available separately. |

Provider keys and endpoints come from the credential store. The runner does not forward arbitrary environment variables. [Process protocol](protocol.md) lists the variables passed to an experiment; [local server reference](local.md) covers server flags and operation.

## Package attributes

| Entry point | Generated experiment launcher | Management tool |
| --- | --- | --- |
| Flake app | `NAME` | `adb-local`, `adb-web`, `adb-runner` |
| Flake package | `experiment-NAME` | The same tool names |
| Classic package | `experiment-NAME` | The same tool names |
| Classic executable output | `exec.NAME` | `exec.adb-local`, `exec.adb-web`, `exec.adb-runner` |

`manifests` builds a directory containing one manifest JSON file per registered experiment. [Working with Nix](../running/nix.md) explains fetching, registry aliases and revision pinning.
