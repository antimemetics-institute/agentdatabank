# Local tools and run storage

Use `adb-local` when you want to launch experiments in the browser. Use `adb-web` when you only want to browse experiments, construct commands, and inspect saved runs. For a first browser run, follow [Run your first local experiment](../running/getting-started.md).

## Start the tool you need

The commands on this page follow your [Nix command settings](#adb-cmd-settings), including flakes, classic Nix, registry use, and local or downloaded source. The default needs neither flakes nor a checkout.

```bash
nix run .#adb-local
```

For the read-only viewer:

```bash
nix run .#adb-web
```

For example, start local ADB on another port without opening a browser:

```bash
nix run .#adb-local -- --no-open --port 8350
```

`adb-local` starts the web application and one local executor that builds and runs submitted experiments. Ctrl-C stops both and interrupts active execution; saved and partial run files remain. `adb-web` starts no executor and cannot submit browser jobs.

Downloaded source normally comes from `main`, which changes over time. To select a particular revision, replace `main` in the archive URL with a commit hash, or use `github:antimemetics-institute/agentdatabank/COMMIT#adb-local` in a flake command. See [Working with Nix](../running/nix.md) for the supported command forms.

## Run from a checkout

In an ADB checkout, start with this command. It always uses the checkout, while following your chosen Nix command format:

```bash,repo-local
nix run .#adb-local
```

`adb-local` chooses experiment source in this order:

- An explicit `--repo DIR`.
- The enclosing Git checkout, if it contains ADB's runner, build support, and experiments directory.
- The source bundled with the launcher, when neither of the above applies.

Thus a remote launcher started inside an ADB checkout also uses that checkout's experiments. Check **Local source** on the run tab, or the terminal's `executing from` line, to confirm the selected directory. `--repo` selects experiment source, not where results are saved. It does not rebuild the launcher's web application or runner. Restart `adb-local` after editing experiment declarations so the browser reloads their definitions. `adb-web` rejects `--repo`.

## Choose where results are saved

The browser server and its executor share one data directory. A terminal experiment must write to that same directory for its runs to appear in the browser.

| Setting | Effect |
| --- | --- |
| `--data-dir DIR` | Selects storage for terminal experiments, `adb-local`, `adb-web`, and verifier run-ID lookup; overrides the environment. |
| `ADB_DATA_DIR` | Shared default for the browser tools and terminal experiments. |
| No explicit directory | Uses `$XDG_DATA_HOME/adb` when `XDG_DATA_HOME` is set; otherwise `~/.local/share/adb`. |

For example, set this in every terminal used for the session before launching either tool or an experiment:

```sh
export ADB_DATA_DIR="$HOME/adb-first-run"
```

Changing the directory selects a different collection of runs; it does not move existing data. To inspect a run directly, use the `store` path printed by the terminal experiment. Under the chosen data directory:

- `conditions/<condition_id>-<experiment>.json` records the experiment source and parameter configuration.
- `runs/<condition_id>-<experiment>/<run_id>/run.json` records run metadata and outcome.
- `runs/<condition_id>-<experiment>/<run_id>/events.jsonl` contains the recorded events, one stream per run.
- `runs/<condition_id>-<experiment>/<run_id>/workspace/` is the experiment's working directory.

## Run the hello test in a terminal

If you used the default data directory in the browser guide, run this command as written. If you chose another directory, set `ADB_DATA_DIR` to that directory first or append `--data-dir DIR`. Commands copied from the browser include its selected data directory.

```bash
nix run .#inspect-hello -- \
  --set model=mockllm/model \
  --set limit=0 --set epochs=1 --set 'generate_args={}'
```

To run your checkout's version of `inspect-hello`, select **local checkout** in the command settings and run from that directory. The named experiment app handles terminal execution; neither browser tool needs to be running. Every declared parameter must be supplied in a terminal command; the browser fills its fields for you. This is a credential-free check using fixed mock replies, rather than the real model in the browser guide. It runs one replicate, both samples (`limit=0`), one pass (`epochs=1`), and no generation overrides. Expect two completed samples, zero errors, and score `1.0`. It needs no credentials or network access after the Nix build.

The runner prints a run ID, a `watch` URL, and a `store` path. It looks for a viewer serving the same data directory on ports 8340–8343. If it finds one, open the `watch` URL. Otherwise, start a viewer and find the run under **Runs** using that viewer’s startup URL. A printed `watch` URL alone does not start a viewer.

Use `--set KEY=VALUE` repeatedly to change parameters, `--replicates N` for more executions, or `--json` to stream event envelopes to the launcher’s standard output while retaining saved run data. Add `--non-interactive` to disable prompts for unattended execution. `--seed N` sets a base seed (random when omitted); each run receives a derived seed. `--dry-run` prints the resolved configuration without executing, and `--describe` prints the experiment's parameter schema.

## Browser launch options

Both tools accept these options:

| Option | Behavior |
| --- | --- |
| `--host ADDR` | Defaults to `127.0.0.1`. `adb-local` accepts loopback names/addresses or wildcard addresses. |
| `--port N` | Defaults to `8340`; if occupied, tries successive ports, up to 20 additional ports. Use the URL printed at startup. |
| `--no-open` | Suppresses automatic browser opening. |
| `--help` | Prints launch options and exits. |

`--host 0.0.0.0` exposes the viewer to the network, but browser execution and credential operations remain restricted to local callers. Use SSH forwarding when you need to execute from a browser on another machine.
