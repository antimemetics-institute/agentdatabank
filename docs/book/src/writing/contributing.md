# Contributing an experiment

The registry is this repo's `experiments/` tree, curated nixpkgs-style — and like nixpkgs, **it packages upstreams, it doesn't absorb them**. Your repo stays your experiment's home; the PR adds a thin wrapper:

```
experiments/my-experiment/
├── package.nix      the mkExperiment declaration (usually a copy of yours)
├── pyproject.toml   depends on YOUR repo — a git dependency pinned by rev
└── uv.lock
```

The wrapper's `pyproject.toml` names your repo as the upstream package and redirects the adb libraries to the in-tree sources (`[tool.uv.sources]` path entries, like every in-tree experiment directory). `impossiblebench/` is the reference: a wrapper with no Python source of its own, wrapping a pinned upstream — here the upstream just happens to be you.

Condition identity is the content hash of the wrapper directory's declared `src`, so the in-tree experiment mints its own condition IDs, distinct from your dev-repo runs — expected and fine; identity records, it never judges, and pooling across content variants is the comparability layer's job at read time.

## What review looks for

Review reads your repo at the pinned rev, plus the wrapper:

- **Name** — experiments get bare names (`nix run adb#my-experiment`), so the namespace is registry-wide and collisions are refused at eval time. Pick like a nixpkgs attr.
- **A keyless path** — the prefilled command should run with zero setup (`mock/model`, or Inspect's `mockllm/model`). That's the smoke test and what CI exercises.
- **Descriptions** — `summary`, per-param `description`s and suggestions are the GUI; write them for someone who hasn't read your code.
- **Links** — `links = [ { label; url; } … ]` points readers at the paper, the upstream repo, and any datasets; shown on the experiment page and each run. Links are pointers, not pins — the pinned rev lives in your lockfile.
- **A tight `src` list** — identity covers behavior only.
- **No paths above the directory** — the declaration must evaluate outside this tree (that is what [forking](external.md#or-fork-one) produces); shared adb data comes through the `adb` argument, never a `../..` path.
- **Committed `uv.lock`, bounded deps** — the wrapped version of your repo is a deliberate line-edit, not silent drift.

## Updating

New versions of your experiment are dependency bumps: a PR moving the wrapper's pinned rev of your repo forward, reviewed as the diff between those two revisions. Changed content mints new condition IDs, as always — that's editing the experiment, and it's yours to do.
