# Working with Nix

If you do not have Nix yet, follow the [official installation instructions](https://nixos.org/download/) for your operating system. The default ADB commands do not require flakes to be enabled.

ADB supports classic Nix and flakes. Both entry points build the same package set and read the same `flake.lock` pin for Nixpkgs. ADB declares Linux and macOS packages for x86-64 and ARM64; individual experiments can have additional platform or service requirements.

## How do I make commands match my setup?

Open [command settings](#adb-cmd-settings) using the toolbar gear. Choose:

- **From GitHub** to fetch ADB without cloning, or **local checkout (.)** to use your current checkout.
- **nix-build** for stock Nix, **flakes** for `nix run`, or **nix-run** for the separate classic runner utility.
- The relevant installed/enabled options for your selected mode.

Commands throughout the book adapt to those choices. Authoring examples always target the local checkout. Preferences persist in this browser.

For GitHub sources, **always fetch latest** makes commands recheck the moving source using `--tarball-ttl 0` or `--refresh`. This is useful during development; a pinned revision is more appropriate when repeating an earlier source version.

## What does each mode execute?

In **nix-build** mode, ADB builds an `exec.NAME` output that points directly to the executable, then invokes it. It needs neither flakes nor a globally installed ADB command.

```sh
$(nix-build --no-out-link -A exec.inspect-hello) --describe
```

In **flakes** mode, experiment names are app names. If flakes are not enabled globally, command settings add `--extra-experimental-features 'nix-command flakes'` to each command.

For example: `nix run .#inspect-hello -- --describe`.

In **nix-run** mode, the separate `nix-run` utility resolves a package's executable. Experiment package attributes use the `experiment-` prefix; tools use their `adb-` names. If the utility is not installed globally, command settings wrap it in `nix-shell -p nix-run --run ...`.

With the utility installed: `nix-run . -A experiment-inspect-hello -- --describe`.

Otherwise:

```sh
nix-shell -p nix-run --run 'nix-run . -A experiment-inspect-hello -- --describe'
```

## How do I use the flake registry alias?

Register `adb` once if you prefer it to the full repository reference:

```sh
nix registry add adb github:antimemetics-institute/agentdatabank \
  --extra-experimental-features 'nix-command flakes'
```

Select **adb registry added** in command settings. The alias is a convenience for the GitHub flake source; classic Nix uses the tarball URL directly.

## How do I pin a source version?

For flakes, a GitHub reference accepts a commit after the repository name. Replace `REV` below with the recorded commit:

```sh
nix run github:antimemetics-institute/agentdatabank/REV#inspect-hello \
  --extra-experimental-features 'nix-command flakes' -- --describe
```

For classic Nix, use the archive for that commit:

```sh
$(nix-build --no-out-link \
  https://github.com/antimemetics-institute/agentdatabank/archive/REV.tar.gz \
  -A exec.inspect-hello) --describe
```

Git-generated archives carry a revision stamp used for the run's fetch reference. An ordinary classic-Nix working-tree build has no expanded archive stamp and records a `dirty:` reference unless an `adbRev` is explicitly supplied to the package import. This is separate from the experiment content hash used for conditions.

## How do I build or develop locally?

From the repository root, build all manifests without running experiments:

```sh
nix-build --no-out-link -A manifests
```

Enter the development shell with `nix-shell`, or `nix develop` if you use flakes. Both supply the project's development tools. Package-specific Python dependencies come from their `pyproject.toml` and `uv.lock` through `uv run`.

A Git flake includes tracked files. Stage newly added source files before evaluating your new experiment through a local flake. Keep run data outside the checkout, and use [the authoring guide](../authoring/experiments.md) for the contribution workflow.
