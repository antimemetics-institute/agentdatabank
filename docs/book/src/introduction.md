# Introduction

The **ADB (Agent Databank)** is a registry of multi-agent AI safety experiments and results.

## Motivation

Multi-agent research is expensive, and fundamentally observes emergent behavior. Nothing agentic is deterministic: you can't draw reliable conclusions from a single run. 

It should be easy to re-run a published result, pause it halfway through, change something, and triplicate both branches. However, today, everyone configures a slightly-different setup, and even when published research includes code, it commonly under-specifies the environment and experimental setup. 

The ADB curates a registry of well-specified experiments, makes it easy to run them, and collates the results.

## Roadmap

The current platform supports local execution and browsing. Public data publication is the next milestone; the unchecked items below are directions to explore, not shipped features or a fixed delivery schedule.

Available now:

- [x] the local loop: a catalog of Nix-packaged experiments, one-command runs, and a browsable run store — with or without cloning the repository, using flakes or classic Nix
- [x] the web GUI: parameter forms, live transcripts, and [Run/Stop with a local job queue](running/workers.md) through `adb-local`
- [x] viewer-only browsing of a local store through `adb-web`
- [x] [credential profiles](running/secrets.md) — ask-once setup, multiple endpoints per provider
- [x] [adding and updating experiments](writing/experiments.md) through ordinary repository pull requests, for humans and coding agents

Before publishing our experimental data:

- [ ] strengthen and test execution provenance: source, resolved environment, inputs, model settings, and historical experiment declarations
- [ ] define and validate a versioned publication format, with downloadable data and instructions for repeating runs and reproducing our analyses
- [ ] publish our own runs and a read-only website for exploring them; Hugging Face hosting and CC-BY-4.0 licensing are proposals, with the format and release terms still to be settled

Possible later work:

- [ ] named parameter presets and opening an existing run in the composer
- [ ] analysis and run comparison, with revisable comparability annotations; this may belong in a separate analysis tool
- [ ] third-party data deposits, with attribution and review (ORCID and operator attribution for agents are possibilities)
- [ ] dedicated experiment-authoring guidance packaged as an agent skill, and sandboxed agent tests of the guide
- [ ] dynamic credential acquisition and explicit non-model credential requirements
- [ ] stronger execution isolation and credential delivery through a recording proxy
- [ ] pausing an experiment and branching its execution to explore alternatives

## How this guide is organized

Top to bottom, by how deep you're going:

- **[Using the platform](running/getting-started.md)** — running experiments and browsing the results. Start at [Getting started](running/getting-started.md); the first loop takes a few minutes with any model credential (or runs keyless against a mock).
- **[Experiment catalog](catalog/inspect-evals.md)** — what you can run today, with exact commands.
- **[Reference](reference/cli.md)** — the CLI surface and the on-disk layout.
