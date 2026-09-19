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

An experiment bucket contains only `runs/` under a caller-selected S3 prefix.
Publication preserves the final `runs/<condition>-<experiment>/<run>/` structure.
Conditions remain groupings of cards; no separate condition object is published.

```text
<prefix>/
  runs/
    <condition>-<experiment>/
      <run>/
        run.json
        events.jsonl.zst
```

Each `events.jsonl.zst` is one level-19 zstd frame, preserving the original JSONL
bytes when decompressed, with `Content-Type: application/zstd`. `run.json` is the
full local card, copied byte-for-byte with `Content-Type: application/json`.
Workspaces are never published. Indexes are derived, live outside experiment
buckets, and are specified separately.

The gate requires a terminal state and a passing `verify` audit, including model
identity checks. Verification resolves the manifest in the same way as
`adb-runner verify`. Failures are reported per run without aborting the batch.
A run is refused if either destination run key exists, checked with HEAD on both
keys. The stream is uploaded first, then the card. Partial uploads are not
overwritten. The publisher uses only HeadObject and PutObject.

`adb-runner publish --to s3://<bucket>/<prefix> [STEM ...]` selects all local runs
unless stems or `--experiment` narrow the selection. Stems are
`<condition>-<experiment>` or `<condition>-<experiment>/<run>`. `--data-dir` follows
the shared flag, environment, XDG resolution. `--dry-run` verifies and
prints keys and sizes without writing. `--profile NAME` selects a boto3 profile;
without it, boto3 resolves configuration normally. No endpoint, region or client
configuration overrides, host presets, remote registry, or target environment
variable belong in ADB.

`nix run .#<experiment> -- … --publish s3://<bucket>/<prefix>` uses the same gate and
upload path after execution. Publication errors are logged without changing run
state or exit code. Ambient AWS variables do not enter the experiment environment;
explicitly supplied experiment credential sets are preserved.

## 6. Deferred

Chunked objects for live runs are deferred because record identity is independent of transport boundaries, so a later uploader can partition the same stream. Derived Parquet tables are deferred because they can be rebuilt from frozen records without changing producers. A fingerprint-keyed manifest registry is deferred because source fingerprints already identify the manifests to index; the registry adds a lookup location rather than changing saved records.

## 7. Indexes

Indexes are derived from the JSON objects under `runs/`. They live outside
experiment buckets, are rebuilt in full on each invocation, and are never
authoritative. The index command writes a directory that the site deploys.
The original card and stream in each experiment bucket retain their bytes.

A user-written store list selects sources; ADB never maps S3 addresses to public
URLs. Its version is `0` and `stores` contains one entry per experiment bucket:

```json
{"v":0,"stores":[{"s3":"s3://bucket/adb-v1","profile":"hf","url":"https://data.example.org/resolve/adb-v1","experiments":["govsim"],"conditions":["condition-id"],"runs":["run-id"]}]}
```

`data.example.org` is an example hostname. `s3` and `profile` select boto3 access;
`url` is the public HTTPS base for the same prefix. Each filter is an optional
list of exact recorded IDs or experiment names. Omission selects everything;
an empty list selects nothing. Present filters intersect. An omitted profile
uses boto3's normal resolution.

`adb-runner index --stores FILE --to DIR [--dry-run]` lists each store's
`<prefix>/runs/`, retaining each `run.json` only when its sibling
`events.jsonl.zst` exists, then reads and filters the cards.
Source profiles belong to the store list. Sessions and S3 clients have no
configuration overrides; the command opens only source clients and uses only
ListObjectsV2 and GetObject. Dry-run prints each store's filtered run count and
every output file and byte size, creating or deleting nothing.
Unreadable, malformed or disappeared cards are skipped with an object-specific
warning; healthy cards from that store and other stores remain in the rebuilt index.
A failure to list a store aborts before replacing the destination.

The destination contains two forms:

```text
index.json
experiments/<experiment>/index.jsonl
```

`index.json` is `{"v":0,"experiments":[{"name":"govsim","runs":1}],"runs":1,
"built_at":"2026-09-18T12:00:00.000000Z"}`. The total and per-experiment counts
count rows. `built_at` uses the event stream's UTC formatter, with six fractional
digits and `Z`. Each experiment shard has one compact JSON row per card:

```text
{"store":"<public HTTPS base>","card":<run.json as a JSON value>}
```

The card is represented as a JSON value, re-serialized compactly with
`ensure_ascii=False` and key order preserved. The index adds no fields to the
card. A rebuild deletes `DIR` and rewrites it in full, with `index.json` written
last. Files for experiments no longer present are removed.

The site repository contains `stores.json` and `site.json`. The complete
`site.json` is `{"v":0}`; unknown keys are rejected. CI builds `adb-web-dist`, copies it into
`site/`, copies `site.json` beside `site/index.html`, runs
`adb-runner index --stores stores.json --to site/index`, and deploys `site/`.
The browser reads `index/index.json` and
`index/experiments/<experiment>/index.jsonl` relative to the app's own directory,
including when the app is served under a path prefix. Without `site.json` the
application uses the local server. Published mode projects cards into run-list
entries and resolves `(condition, run)` to the row's store. Opening a run fetches that store's
`runs/<condition>-<experiment>/<run>/run.json` and `events.jsonl.zst`. A pure-JS
zstd decoder preserves the decompressed lines for raw display. Raw card display
uses the fetched `run.json`, never the re-serialized index value. Large params
are thinned in the browser and expand from the original card.

Objects under `runs/` are immutable session caches. The index is revalidated
once a minute. Damaged rows, missing shards, unreadable objects and
identity mismatches become diagnostic run entries with reasons; healthy
neighbors remain visible. Manifests and render hints ship with the static
bundle, keyed by experiment and schema version; unmatched versions use shared
hints. Execution surfaces, publication controls and jobs are hidden. Fetches
omit credentials on every hop and follow redirects, including to signed CDN URLs
on other hosts. The local Node server has no role in this flow and never
reads a bucket.

The client holds the whole list today, so JSONL shards are the initial transport.
If querying is needed, it is a browser-side question; `index.sqlite` from the
same command is the candidate. Analysis tables in Parquet remain the §6 deferral.
