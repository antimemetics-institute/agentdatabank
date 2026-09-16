---
rfc: 2
title: Schema versioning, identity, and releases
status: draft
---

# RFC 0002: Schema versioning, identity, and releases

## 0. Envelope

Every record carries `v: int` (envelope shape, currently 0), `ts` (aware UTC
capture datetime), `run: str` (execution identifier), `experiment: str` (payload
schema family), `schema: NonNegativeInt` (that experiment's payload union
version), `seq: NonNegativeInt` (runner-assigned capture order), and `event`
(the validated payload). `(run, seq)` identifies a record; sequence alone does
not prove causal order across processes. `ts` always has six fractional digits
and a trailing Z, as in `2026-09-14T12:00:00.123456Z`, and rejects naive input.
`LLMCall.completed` uses the same UTC type and serializer. Python spells the
schema attribute `schema_`; JSON uses `schema`.

## 1. Envelope and payload versions

`v` versions only the envelope shape. An experiment's integer `schema` identifies
its full payload union, including shared vocabulary and its custom events. The
manifest declares `schema = { version, models }`, where `models` is a
`module:attribute` pointer; GovSim uses version 0 and
`govsim_adapter.models:Payload`. The runner stamps experiment and version on
every record. The manifest file's own `schema_version` is a third, independent
version, currently 1 for ordered, named result declarations. Readers select the appropriate union without rewriting saved records.

## 2. Compatibility and bumps

A schema version bumps only when records already written would fail to
deserialize under the new module. Adding optional fields, union members, or
literal values never bumps the version. Additive changes go in the current
schema module; readers use its latest compatible library. The same compatibility
rule applies to `v` for envelope changes. Incompatible changes
require a new schema module and an experiment schema-version bump, retaining the
old module for old records. Adding a raw harness record event alone therefore
neither creates GovSim schema 1 nor changes existing GovSim run bytes.

## 3. Frozen-module guard

Frozen schema modules are never edited. The guard in
[test_frozen.py](../../lib/adb-events/tests/test_frozen.py) compares SHA256 hashes
of `inspect_chat.py` and `models/llm.py` with
[frozen.json](../../lib/adb-events/tests/frozen.json), including comments and
provenance. Do not refresh those hashes to admit edits to published snapshots.
The current schema module is the extensible entry point: compatible declarations
and union additions there compose around unchanged frozen models. This permits
additive evolution without changing snapshots or bumping the schema version.

## 4. Source fingerprint

`source` fingerprints the experiment's declared source paths plus the shared
Python library source directories its program imports. `mkExperiment.sharedSrcs`
defaults to `lib/adb-events/adb_events` and
`lib/adb-experiment/adb_experiment`; Inspect programs also include
`lib/adb-inspect/adb_inspect`. `cleanImport` excludes development artifacts, and
surrounding tests, READMEs and tooling stay outside the library source paths.
The runner, web and docs are excluded. A GovSim adapter comment changes GovSim's
fingerprint without changing Concordia's; an `adb_events/emit.py` change affects
both. This fingerprint identifies declared content, not all external influences
on an execution. The [identity note](../book/src/running/model.md) describes its
use when comparing runs.

## 5. Fetch reference

`fetch_ref: str | None` identifies a pinned clean repository revision from which
the packaging source can be fetched. A dirty tree has no `fetch_ref`; neither
does a launch with no known pinned clean revision. None is omitted on the wire.
The launcher rejects userinfo before exporting a reference. A source fingerprint
or packaging hash cannot stand in for a fetchable revision, and a saved reference
does not by itself guarantee that the revision will remain available.

## 6. Packaging tree hash

`tree_hash: str | None` is the packaging tree's NAR hash. The launcher emits it
whenever known, for clean and dirty trees alike. It identifies that packaging
tree independently of the narrower experiment `source` fingerprint and does
not participate in condition identity. It is evidence of content, not a storage
location: recovering a dirty tree still requires preserving its bytes.
`tree_hash` is recorded only where the launcher can compute it, today flake
builds; its absence carries no meaning.

## 7. Execution snapshot

`run.start` carries launch facts and `run.end` carries terminal process facts;
neither contains aggregates of other records. The stream is the truth, the card
is a cache of it, and nothing reads the card as an input. Runs record the derived
seed, not the launcher's replicate ordinal. The ordinal remains an input to seed
derivation; persisted batch facts belong only to the local jobs file. The sections of the
runner's index card, local storage and published layout are defined in
[RFC 0003](0003-run-directory-and-published-layout.md). Runtime closure paths can
differ between the flake and classic doors on a checkout with untracked files
while `source` does not: `source` is identity, and closure paths are covariates.

## 8. Condition as pooling key

`condition = hex(sha256(JCS({experiment, source, params})))[:40]` is the pooling key for
runs with the same declared experiment, fingerprint and bound input values.
This is 160 bits, matching the Nix store's hash width, encoded as 40 lowercase
hexadecimal characters. `canonical.condition_id` is the single implementation;
records and paths use its result unchanged. Condition storage names append
`-<experiment>`; readers derive those names from the recorded fields and never
parse the suffix. Each execution has its own run identifier,
`yyyymmddthhmmssz-<12 lowercase hex random>`, using the launching machine's UTC
clock and six random bytes. The whole string is the ID; its date is a launch-time
label, not evidence. Seeds, replicate numbers, credential
profiles, endpoints, runner/platform details, fetch references and packaging
tree hashes are outside this key. Pooling establishes matching declared inputs;
it does not assert equivalent provider behavior or scientific comparability.

## 9. Releases

Releases are labels applied to fingerprints after the fact in an external
catalog. They are never written into runs and never change a run's fingerprint,
condition or schema. A release label can organize previously collected data
without rewriting any record; recorded content identity remains authoritative.

## 10. Behavior versions

An experiment behavior version, such as `2026.09.1`, is independent of schema
compatibility. A behavior change can change the source fingerprint while using
the same schema, and a compatible schema addition does not prescribe a behavior
release. Behavior labels are never coupled to schema integers.
