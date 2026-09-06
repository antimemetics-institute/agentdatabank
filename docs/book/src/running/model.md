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

The same experiment name, source hash, and parameters produce the same condition ID. The hash is recorded on every run, runs are grouped under it on disk, and the GUI shows it — but there is no condition aggregation or dedicated comparison view yet. Matching IDs do not establish scientific comparability: shared dependencies and execution settings outside the declared sources can differ. Publication and analysis are separate items on the [roadmap](../introduction.md#roadmap).

## Run

A **run** is one execution of a condition — one sample drawn from it. Its id is a ULID. A run records the parameters, the experiment version (`source`), a source reference (`fetch_ref`, which may instead mark a dirty checkout), its seed, status, and event stream. The runner records its version and platform in the start event; additional provenance depends on the adapter. This is not yet a complete execution-environment fingerprint.

Agents are non-deterministic, so ADB never deduplicates. Two runs of the same condition are two samples; the databank accumulates *n*. Failed and interrupted runs are kept too — garbage is data.

## How they nest

{{#include ../diagrams/model-nest.svg}}

## Three distinctions worth knowing

- **Identity is not reproducibility.** You can't `nix run` a content hash. The recorded `fetch_ref` helps locate the source, but a dirty checkout is not a retrievable revision, and a source reference alone does not preserve every input or hosted model. Stronger reproduction guarantees remain on the roadmap.
- **Environment is a covariate, not identity.** The condition hash excludes the shared runner and platform. The runner records its own version and platform; adapter-specific library metadata is not a complete dependency inventory. Upgrading the runner does not change the condition hash.
- **Secrets are never identity.** The model *name* (`openai/qwen3.5-9b`) is part of the condition; the endpoint and key that serve it are environment — see [Credentials](secrets.md). Reported model information is available from some adapters, including Inspect, but is not captured uniformly across experiments. Endpoint and credential-profile provenance is also incomplete today.
