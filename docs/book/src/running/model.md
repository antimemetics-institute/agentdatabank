# Experiments, conditions, runs

Three entities carry ADB's data model. Understanding them is most of understanding the platform.

## Experiment

A parameterized agent experiment, with its own parameters and its own identity. Each Inspect eval task is its own experiment — `inspect-gsm8k`, `impossiblebench-livecodebench`, `inspect-hello`, … — while all of [Concordia](../catalog/concordia.md) is one experiment whose params compose the scenario. The boundary is code versus data: which task you ran is never a parameter — it's *which experiment* you ran — but a Concordia cast is data, so it's params.

An experiment is versioned by a content hash of the code that defines it, not by the whole repo. There is no version field to maintain: the content is the version. Editing an experiment changes its identity. Bumping the shared runner or nixpkgs changes nothing — every experiment's conditions stay byte-identical. Experiments defined by the same subtree re-version together: both ImpossibleBench experiments share one directory, so updating its pin re-buckets both (see [ImpossibleBench](../catalog/impossiblebench.md)).

## Condition

A **condition** is an experiment version plus a full parameter binding — a completely specified configuration. Its identity is a hash:

```
condition_id = sha256(canonical({experiment, source, params}))
```

Configure the same experiment the same way, on any machine, and you land in the same bucket. This is the coordination mechanism of the whole databank: it's what will let deposited runs pool across researchers once depositing lands. In the MVP the hash is computed and recorded on every run, runs are grouped under it on disk, and the GUI shows it on every run — but nothing groups or aggregates by condition yet.

## Run

A **run** is one execution of a condition — one sample drawn from it. Its id is a ULID. A run records the parameters, the experiment version (`source`), a fetchable repo rev (`fetch_ref`) it can be re-run from, an environment fingerprint, its status, and the full event stream.

Agents are non-deterministic, so ADB never deduplicates. Two runs of the same condition are two samples; the databank accumulates *n*. Failed and interrupted runs are kept too — garbage is data.

## How they nest

{{#include ../diagrams/model-nest.svg}}

## Three distinctions worth knowing

- **Identity is not reproducibility.** You can't `nix run` a content hash. That's why each run also records `fetch_ref` — a rev you *can* fetch and re-run. Identity buckets the run; `fetch_ref` reproduces it.
- **Environment is a covariate, not identity.** Runner version, library versions, platform — recorded on every run so you can slice on them later, never folded into the hash. Upgrading the runner doesn't shatter your buckets.
- **Secrets are never identity.** The model *name* (`openai/qwen3.5-9b`) is part of the condition; the endpoint and key that serve it are environment — see [Credentials](secrets.md). The model the provider *reports* serving is likewise recorded per call, and the run view shows it next to what was requested.
