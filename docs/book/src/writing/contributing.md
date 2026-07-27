# Contributing an experiment

The registry is this repo's `experiments/` tree, curated nixpkgs-style: an experiment lands by PR, review happens once, and everyone downstream runs reviewed code.

A contribution is your family directory, **copied in verbatim**:

```
experiments/my-exp/  ←  my-exp/
```

No adaptation — the `package.nix` shape is identical in and out of tree; only your `flake.nix`/`flake.lock` scaffolding stays behind. Keep the copy byte-identical: condition identity is the content hash of your `src` paths, so an unchanged subtree means the condition IDs you recorded while developing are the same ones the merged experiment produces. Your pre-merge runs stay comparable with everyone's post-merge runs.

## What review looks for

- **Name** — experiments get bare names (`nix run adb#my-exp`), so the name is registry-wide and collisions are refused at eval time. Pick like a nixpkgs attr.
- **A keyless path** — the prefilled command should run with zero setup (`mock/model`, or Inspect's `mockllm/model`). That's the smoke test and what CI exercises.
- **Descriptions** — `summary`, per-param `description`s and suggestions are the GUI; write them for someone who hasn't read your code.
- **A tight `src` list** — identity covers behavior only; tests and docs stay out.
- **Committed `uv.lock`, bounded deps** — wrapped-tool versions are a deliberate line-edit, not silent drift.

## After the merge

Your experiment is `nix run adb#my-exp`, appears in the GUI's catalog and the manifests output, and runs record a pinned fetchable ref (`github:…/<rev>`) instead of `dirty:`. The name is yours; changes to it go through the same review.
