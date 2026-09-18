---
rfc: 3
title: Run directory and published layout
status: draft
---

# RFC 0003: Run directory and published layout

## 0. Evidence versus convenience

The stream is evidence, frozen and addressed by `(run, seq)`. `run.json` is the runner's index card: a cache of stream facts plus lifecycle state and derived values. Everything on the card is a copy of a record or derivable from the stream, apart from the runner's operational live state; a test asserts the copies and derivations. The stream wins on disagreement. A fact that exists only on the card is not evidence, and nothing reads the card as an execution input.

## 1. Lifecycle records

`run.start` and `run.end` contain facts true at that moment, known by the runner and needed to interpret other records, never anything derived from other records. Start records identify the condition, inputs and launch provenance; end records give process state, duration and exit code. Results, token totals and activity counts belong in a projection of the stream, not in either lifecycle event.

## 2. The card

`identity` copies run, experiment and schema from the start envelope and condition from its payload; `inputs` copies params and the run seed; `lifecycle` holds runner-owned state, start/end capture timestamps and terminal process facts; `provenance` copies source, optional fetch_ref and tree_hash, and runtime; `definitions.results` copies the ordered result declarations; `derived` caches declared results (last value wins), model usage, counts, latest status and the last included event position. The runner replaces the card atomically at each live heartbeat and at run end; the file's modification time provides liveness without a stored heartbeat field. Consumers may use it for listings and summaries; its contents can always be checked against records. Batch facts belong only to the local jobs file, not the card or stream.

A condition is a grouping of run cards, not a stored object. Condition identity, experiment, source and params live on every card and `run.start`; readers group cards on `condition` and take shared fields from any member. These fields are identical by construction of the condition hash.

## 3. The run directory

A local run contains `run.json`, one `events.jsonl` stream file, and `workspace/`. The workspace holds local upstream working files and is never published. Evidence to retain from those files must first enter the stream through the producer's capture or ingestion boundary. There is one stream file per run, with sequence numbers identifying records independently of their byte positions.

## 4. Directory names

The final layout for local and published stores is `runs/<condition>-<experiment>/<run>/`, containing the card and stream (plus a local-only `workspace/`). There is no separate condition resource. The condition is the first 40 hexadecimal characters of SHA-256 over canonical JSON, as defined in RFC 0002; the suffix is informational and readers construct it from recorded fields, never parse it. Run IDs use the readable UTC form `yyyymmddthhmmssz-<12 lowercase hex random>` from the launching machine's clock. The whole string is the ID, and its date is a launch-time label, not evidence.

## 5. Published layout

Publication preserves the same run structure under a version prefix, plus `index.jsonl` with one row per `run.json`. The stream is published as `events.jsonl.zst`, one object per run, uploaded with `Content-Encoding: zstd` and `Content-Type: application/x-ndjson`; the card accompanies it and the workspace does not. Objects for terminal runs are never rewritten. A new layout is a new version prefix produced from the records, so repairing or replacing a convenience projection cannot mutate published evidence.

## 6. Deferred

Chunked objects for live runs are deferred because record identity is independent of transport boundaries, so a later uploader can partition the same stream. Derived Parquet tables are deferred because they can be rebuilt from frozen records without changing producers. A fingerprint-keyed manifest registry is deferred because source fingerprints already identify the manifests to index; the registry adds a lookup location rather than changing saved records.
