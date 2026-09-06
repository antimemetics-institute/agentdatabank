# Running from the GUI

The [run-config builder](web.md#the-run-config-builder-composer) composes a one-liner; pasting it into a terminal is always the canonical way to run an experiment. But the composer also has a **run** tab that launches the same condition without leaving the browser — pick credential profiles, set replicates, press run, watch the job report in place. Each run it starts appears in the runs table like any other, with a link to its page.

The web server itself never executes anything. Running is a **worker**'s job: a separate process, usually on the same machine, that claims queued jobs and runs them. The panel stays greyed out until a worker is connected — the GUI tells you what to start.

## The one-command local setup

```console
$ nix run .#adb-local
```

That starts the web GUI **and** one worker, wired together, torn down together with a single `Ctrl-C`. For running experiments on your own machine from your own browser, this is all you need.

Started from inside a repo checkout (this repo or a Git fork of it), the worker builds experiments from **that checkout** — edits are picked up on the next run, no restart needed. Started anywhere else, it runs the pinned source it was built from.

## What a job is

Pressing run enqueues exactly what the composed one-liner says: the experiment name, every `--set` binding, replicates, and the credential **profile names** you picked. Nothing else — no secrets (the worker resolves profile names against its own credential store) and no code locations (a worker only ever builds from the repo its operator configured it with). The job record lands in the run store (`$ADB_HOME/jobs/`) and survives restarts of both server and worker.

While a job runs, the panel shows its phase (`building` → `running` → `completed`), the run ids as the runner announces them, and a tail of the runner's narration. **Stop** delivers the equivalent of `Ctrl-C` to the job — in-flight runs are kept and marked `interrupted`, same as stopping a terminal run.

## Running the pieces separately

```console
$ nix run .#adb-web       # the GUI: serves and queues, executes nothing
$ nix run .#adb-worker    # a worker: finds the local GUI and serves it
```

A worker with no `--server` probes the local GUI ports (`8340`–`8343`) and attaches to the first adb-web it finds. Useful when the GUI outlives your workers, or the worker should run under different credentials or a different `--repo`:

| Flag | Meaning |
|---|---|
| `--server URL` | The queue to serve. Default: probe `127.0.0.1:8340`–`8343`. |
| `--name NAME` | How the worker introduces itself in the GUI (default: hostname). |
| `--repo SRC` | What it builds experiments from: a checkout path or a repo tarball URL. Default: the pinned source the worker was built from. Point it at your fork to serve that fork's experiments. |
| `--token-file FILE` | Bearer token for a non-loopback server (a file, never argv). |
| `--once` | Execute one job, then exit (cron, smoke tests). |

Workers are headless by design: they never prompt. A job that needs an unconfigured credential set fails honestly into the job log, and the fix is `credentials set` on the **worker's** machine — secrets live where execution happens and never travel through the browser or the queue.

## A worker on another machine

The GUI accepts non-loopback workers only when both sides share a token:

```console
$ ADB_WEB_TOKEN=<token> nix run .#adb-web -- --host 0.0.0.0
```

and on the worker machine:

```console
$ nix run github:{{repo}}#adb-worker -- --server http://<gui-host>:8340 --token-file /path/to/token
```

The worker registers under its hostname and advertises which credential sets it has configured (names only — values never leave its machine), so the GUI's credential picker offers what that worker can actually honor.

## As a NixOS service

For a permanent worker — a lab box that serves your team's GUI — the repo ships a NixOS module:

```nix
{
  imports = [ (adb + "/pkgs/adb-worker/module.nix") ];
  services.adb-worker = {
    enable = true;
    package = (import adb { }).adb-worker;
    serverUrl = "http://192.168.1.10:8340";
    tokenFile = config.age.secrets.adb-worker-token.path;
    credentialsFile = config.age.secrets.adb-credentials.path;
  };
}
```

Secrets are **files** delivered by your secret manager (agenix, sops-nix, …), never Nix-store values: they reach the service via systemd's `LoadCredential`, readable by that service alone. `credentialsFile` is a `credentials.toml` in the [same shape the CLI writes](secrets.md); `repo` (optional) points the worker at a fork. The worker builds with Nix, so allow its dynamic user in `nix.settings.allowed-users`.
