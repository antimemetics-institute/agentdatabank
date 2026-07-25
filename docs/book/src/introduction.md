# Introduction

The **ADB (Agent Databank)** is a registry of multi-agent AI safety experiments and results.

## Motivation

Multi-agent research is expensive, and fundamentally observes emergent behavior. Nothing agentic is deterministic: you can't draw reliable conclusions from a single run. 

It should be easy to re-run a published result, pause it halfway through, change something, and triplicate both branches. However, today, everyone configures a slightly-different setup, and even when published research includes code, it commonly under-specifies the environment and experimental setup. 

The ADB curates a registry of well-specified experiments, makes it easy to run them, and collates the results.

## Roadmap

The current platform is an **MVP**, and is only meant to be run locally.

Planned features (in somewhat priority order):
- [ ] automatically depositing runs to HuggingFace
- [ ] website running publically, indexing runs on HuggingFace
- [ ] claude skill for implementing an experiment

## How this guide is organized

Top to bottom, by how deep you're going:

- **[Using the platform](running/getting-started.md)** — running experiments and browsing the results. Start at [Getting started](running/getting-started.md); the first loop takes a few minutes with any model credential (or runs keyless against a mock).
- **[Experiment catalog](catalog/inspect-evals.md)** — what you can run today, with exact commands.
- **[Reference](reference/cli.md)** — the CLI surface and the on-disk layout.
