# Getting started

The smallest path from nothing to a finished run you can look at.

## 1. Install nix

The ADB relies on nix, a metalanguage for pinning dependencies and running commands.

**Follow the instructions** at <https://nixos.org/download/>, and validate your install by running:

```bash
nix --version
```

The commands in this guide work on a stock install by default. If you're running from a local checkout, or you've configured a [custom nix setup](nix.md), check the [⚙ command settings](#adb-cmd-settings) in the toolbar.

## 2. Start the local ADB

```bash
nix run .#adb-local
```

This starts the WebUI together with a worker for this machine — compose *and* run experiments without leaving the browser. Your browser should open <http://127.0.0.1:8340>.

> Want just a read-only viewer? `nix run .#adb-web` starts the WebUI without execution. See [Running from the GUI](workers.md) for local execution and SSH forwarding.

<details>
<summary><b>WebUI doesn't open?</b> (e.g., running on a remote machine)</summary>

> By default the server binds `127.0.0.1`, reachable only from the machine it runs on. If ADB runs on a remote box (a lab server, a VM), either:
>
> **SSH port forward** (recommended):
>
> ```bash
> ssh -L 8340:127.0.0.1:8340 you@remote-box
> ```
>
> Then open <http://127.0.0.1:8340> in your **local** browser; the tunnel carries it to the remote server.
>
> **Bind all interfaces**:
>
> ```bash
> nix run .#adb-local -- \
>   --host 0.0.0.0
> ```
>
> Then open `http://<remote-box>:8340`. Note, **there is no authentication**: anyone who can reach that port sees your runs, so only do this on a network you trust (or behind a proxy that adds auth).
>
> **Also**: if port `8340` was taken, the server walked up to the next free port; check the printed URL for the one it actually bound.

</details>

<br/>
<img class="only-light" src="../images/overview-light.png" alt="The overview — one card per experiment in the catalog, no runs yet">
<img class="only-dark" src="../images/overview-dark.png" alt="The overview — one card per experiment in the catalog, no runs yet">

## 3. Run your first experiment

In the WebUI, click into [inspect-hello](http://127.0.0.1:8340/#/experiments/inspect-hello): the run-config builder is prefilled — pick your model (e.g. `anthropic/claude-sonnet-4-5-20250929`) and press **▶ run**:

<video class="only-light" autoplay loop muted playsinline src="../images/builder-form-light.webm"></video>
<video class="only-dark" autoplay loop muted playsinline src="../images/builder-form-dark.webm"></video>

The first run against a real model asks for that provider's credentials right in the run tab — a key entered once, saved to the same store the CLI uses (see [Credentials](secrets.md)).

> **No key at hand?** `model=mockllm/model` runs the same task against a mock response and needs no credentials.

The job reports in place — queued, building (the first build takes a little longer than thereafter), running — and links the run as soon as it starts. Click through to follow the transcript live:

<video class="only-light" autoplay loop muted playsinline src="../images/run-view-light.webm"></video>
<video class="only-dark" autoplay loop muted playsinline src="../images/run-view-dark.webm"></video>

That's the loop: **compose → run → look**. Try **inspect-gsm8k** with `limit=10` next.

### Prefer the terminal?

The builder's **oneliner** tab composes the exact same condition as a copy-paste command:

```bash
nix run .#inspect-hello -- \
  --set model=anthropic/claude-sonnet-4-5-20250929 \
  --set limit=0 \
  --set epochs=1 \
  --set 'generate_args={}'
```

Pasted anywhere, it reproduces the same condition — that command *is* the run's complete spec. On first use it prompts for credentials in the terminal, then prints the link to watch the run in the WebUI. See [Running experiments](cli.md) for the full CLI story.

## Where to go next

- **[Experiments, conditions, runs](model.md)** — what that condition hash was about, and why every run is a sample in a shared bucket. The one piece of theory worth reading.
- **[Running experiments](cli.md)** — `--describe`, `--dry-run`, `--replicates`, and how the no-defaults rule works.
- **[Credentials](secrets.md)** — the full story: the ask-and-save flow, manual setup per provider, local model servers, multiple endpoints at once, and the trust model.
- **[The experiment catalog](../catalog/impossiblebench.md)** — everything you can run today, starting with ImpossibleBench.
