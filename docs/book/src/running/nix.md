# Working with Nix

[Getting started](getting-started.md) gave you commands that just work. This chapter is for making them nicer — shorter, pinned for a paper, or pointed at a local checkout. None of it is required.

<div class="warning">

**The [⚙ command settings](#adb-cmd-settings) do all of this for you.** Pick where you're running **from** (GitHub or a local checkout) and what you're running **with** — the `nix-build` (default), `flakes`, or `nix-run` tab — and every command in this guide rewrites itself to match your setup. The web GUI's bottom-left settings menu offers the same choices, stored in the same place. This chapter explains what each choice changes.

</div>

## The command forms

The same run has several spellings. They differ only in ceremony, not in what they do — and **condition identity always uses the resolved git revision the runner records**, never the ref you typed, so the pretty and pinned forms bucket identically.

| Form | Looks like | When |
|---|---|---|
| **Local checkout** | `nix run .#inspect-hello -- …` | you cloned the repo and are inside it |
| **GitHub, full** | `nix run github:{{repo}}#inspect-hello -- …` | you don't have the repo — works with nothing else set up |
| **GitHub, registered** | `nix run adb#inspect-hello -- …` | you added `adb` to your flake registry (below) |
| **Pinned** | `nix run github:{{repo}}/<rev>#inspect-hello -- …` | reproducibility — this is what you paste into a paper's appendix |

## Making them shorter: the flake registry

Registering `adb` once lets you write `adb#…` instead of the full GitHub URL — the same way `nixpkgs` is already registered for you:

```bash
nix registry add adb github:{{repo}}
```

The registry ref floats to the latest commit, which is fine: the runner records the *resolved* revision, so your run is still exactly identified.

## Always fetching the latest

Nix caches downloads: once it has fetched `main` (as a tarball or a flake ref), it reuses that copy for a while rather than asking GitHub again — so a rerun can silently execute code that's a few commits behind. The "always fetch latest" checkbox in the [⚙ command settings](#adb-cmd-settings) (on by default, GitHub source only) makes every command re-check: `--tarball-ttl 0` on `nix-build`, `--refresh` on `nix run`, `--option tarball-ttl 0` on `nix-run`. If nothing changed upstream, the check is a cheap no-op — nothing is re-downloaded or rebuilt. Untick it to save the round-trip, or when you're running from a local checkout (where there's no download to go stale and the checkbox doesn't apply). Pinned `…/<rev>` commands don't need it either — a pin resolves the same way every time.

## The experimental-features flag

`nix run` needs two experimental features, `nix-command` and `flakes`. The commands in this guide **opt in explicitly, per command** — nothing global to configure, works on a stock install:

```bash
nix run github:{{repo}}#adb-web --extra-experimental-features 'nix-command flakes'
```

(The flag rides with the `nix run` invocation, before the `--` that separates the experiment's own arguments.)

If you use flakes regularly you can enable the features permanently and drop the flag. How depends on your setup — a NixOS or nix-darwin configuration, Home Manager, or a plain `nix.conf` — see the official wiki's [Flakes page](https://wiki.nixos.org/wiki/Flakes) for each. Once enabled, tick "flakes enabled globally" in the [⚙ command settings](#adb-cmd-settings) and every command in the guide sheds the flag.

## Running without flakes

If you'd rather not enable flakes at all, the repo's `default.nix` is a plain classic entrypoint — no flakes anywhere in the path, pinned to the same nixpkgs, building exactly the closure the flake builds. Two ways to run through it, each a "running with" tab in the [⚙ command settings](#adb-cmd-settings): pick `nix-run` or `nix-build` and every command in the guide rewrites to that form.

**Via [`nix-run`](https://tangled.org/weethet.eurosky.social/nix-run)** (in nixpkgs) — a classic-Nix runner that, like `nix run`, resolves a package's `meta.mainProgram` and passes program arguments after `--`. Point it at a tarball of the repo (or `.` inside a checkout):

```bash
nix-run https://github.com/{{repo}}/archive/main.tar.gz \
    -A experiment-inspect-hello -- \
  --set model=mockllm/model \
  --set limit=0 \
  --set epochs=1 \
  --set 'generate_args={}'
```

Experiments are `-A experiment-<name>`; the tools are `-A adb-runner` and `-A adb-web`. Don't have `nix-run` installed? Run it from a throwaway shell — wrap the whole command (the `nix-run` tab's "installed globally" checkbox picks between these):

```bash
nix-shell -p nix-run --run "nix-run … -A experiment-inspect-hello -- …"
```

**Via stock `nix-build`** — nothing installed beyond Nix itself. The `exec.<name>` attributes (bare app names, same names `nix run` uses) have outputs that *are* the executables, resolved through `meta.mainProgram`, so it's a one-liner with no `./result` litter and no binary-name knowledge:

```bash
$(nix-build --no-out-link https://github.com/{{repo}}/archive/main.tar.gz \
    -A exec.inspect-hello) \
  --set model=mockllm/model \
  --set limit=0 \
  --set epochs=1 \
  --set 'generate_args={}'
```

One honest caveat for both: classic Nix has no evaluation cache, so every flakeless invocation re-evaluates the whole tree (tens of seconds) where flake commands are instant after the first run. Flakes are the happy path; this door exists so nobody is locked out.
