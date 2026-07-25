# The web GUI

The web GUI is a local browser app for reading your runs. It shows exactly what the runner wrote — in-progress runs show up live, and it needs no credentials of any kind.

## Launch it

```console
$ nix run .#adb-web
```

It binds `127.0.0.1:8340` (walking up to the next free port if 8340 is taken) and reads the same run store the runner writes (default `~/.local/share/adb`).

| Flag | Meaning |
|---|---|
| `--host ADDR` | Bind address. Default loopback; `--host 0.0.0.0` exposes it to the network (no auth — trusted networks only). |
| `--port N` | Listen port (default `8340`; walks up if taken). |
| `--home DIR` | Run store to serve (default `$ADB_HOME`, else `~/.local/share/adb`). |
| `--no-open` | Don't auto-open the browser. |

On a machine with a local browser it also opens the URL for you. Where that can't work — over SSH, or behind a code-server proxy — it just prints the URL instead; see [Getting started](getting-started.md) for the port-forward recipe. `ADB_NO_OPEN=1` turns auto-open off entirely.

## Pages

| Route | Page | Shows |
|---|---|---|
| `#/` | **Overview** | A searchable grid of experiment cards: summary, run counts by phase, last-run time. Experiments with zero runs still get a card, from the manifest catalog. |
| `#/experiments/<name>` | **Experiment** | The experiment's runs table and the **run-config builder**. |
| `#/runs` | **Runs** | A flat run table across all experiments (experiment, params, phase, results, start time). |
| `#/runs/<rid>` | **Run detail** | The run's params, results, and the event feed — with filter chips narrowing it to one event family (messages, llm calls, metrics, …). Polls live every 2s. |

Runs carry their condition hash (visible on the run detail page), but the GUI doesn't yet group or aggregate by condition.

## Live runs

Run pages poll for new events every 2 seconds, so you watch `provisioning` → `running` → a terminal phase as it happens. The runs list also tracks liveness: a `running` run whose runner stopped signaling shows as `interrupted?` — never silently hidden. (The heartbeat mechanics are in [Run directory layout](../reference/layout.md).)

## The run-config builder (composer)

The experiment page hosts a form generated from the experiment's schema, prefilled from its `initial` values. It regenerates the exact `nix run .#<experiment> -- --set …` one-liner as you edit — every param becomes a `--set`, because [experiments have no defaults](cli.md#every-param-is-on-the-command-line), so the copied one-liner is the complete condition spec. The model field suggests concrete models, each noting which credentials it needs (see [Credentials](secrets.md)).

It builds the command; it never runs anything. You copy the one-liner into a terminal.

The **settings** menu in the bottom-left adapts the composed command to your Nix setup — the same choices as this guide's [⚙ command settings](nix.md), stored in the same place, so setting one sets both.

## Env vars

Flags are how you configure the GUI; env vars exist as deployment fallbacks and for context shared with the runner, and the `nix run .#adb-web` wrapper sets the deployment ones for you. The full table is in the [CLI reference](../reference/cli.md#environment-variables).
