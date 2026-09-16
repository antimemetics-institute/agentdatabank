---
rfc: 1
title: Event basics and model API instrumentation
status: draft
---

# RFC 0001: Event basics and model API instrumentation

ADB records strict Pydantic payloads in a runner-owned JSONL stream. Experiments
define their own typed custom observations alongside a small shared technical
vocabulary. Analysis requires Pydantic, with no Inspect or OpenTelemetry runtime.

## 0. Shared v0 vocabulary

The shared wire tags are exactly these nine:

| Tag | Meaning |
| --- | --- |
| `run.start` | The runner begins launching an execution and snapshots provenance and inputs. |
| `run.end` | Terminal process state, duration and exit code. |
| `llm.call` | One observed model API operation, its effective request and available outcome. |
| `custom` | An experiment-defined observation discriminated by its namespaced `kind`. |
| `result` | One scalar result declared by the experiment's manifest. |
| `status` | the producer's current human-readable progress phrase; latest wins; structured progress belongs in custom events. |
| `log` | A deliberate diagnostic with `debug`, `info`, `warn` or `error` severity. |
| `stdout` | A captured stdout line, including text that happens to be JSON. |
| `stderr` | A captured stderr line; stderr alone does not establish failure. |

Only the runner emits lifecycle records. Producers submit validated payloads
through `adb_events.emit` or `adb-emit`. A valid partial transcript may lack
`run.end`; absence alone establishes neither success nor continued execution.
The [events reference](../book/src/reference/events.md) specifies the fields.

`condition` is the single deliberate derived value in the stream, a hash of
experiment, source and params on the same record, kept because it is the identity
readers use to locate and pool runs; it is not precedent for other derived values.

## 1. Model calls

`LLMCall` keeps Inspect AI 0.3.263's boundary data fields: `model`, `input`,
`tools`, `tool_choice`, `output`, `call`, `error`,
`completed`, `working_time`, and `metadata`. Chat, content, citation, tool,
output and usage models are vendored in
[inspect_chat.py](../../lib/adb-events/adb_events/inspect_chat.py), with the
source version, archive hash, local changes and MIT license in its header.

**Boundary rule.** `llm.call` holds what crossed the model API, plus ADB timing
and agent attribution. Facts only a harness runtime knows, including roles,
retries, local caches, sandbox error classes and viewer hints, are harness data
recorded raw by that harness's adapter. Inspect is one such harness: its data
models are vendored for the boundary, not its runtime. The worked example is
removing `role`, `retries` and `cache` from `LLMCall`, `ChatMessageBase.source`,
and `ToolCall.view` with its `ToolCallContent` viewer model. `ToolCall.parse_error`
remains boundary parsing evidence; `ToolCallError.type` is an open string set
from API evidence (Anthropic's error flag becomes `"error"`) or a harness's own
error type. `instance_id` and `repeat` were also removed as deferred ADB
attribution, expected to return with instance work; they are not harness data.

Generation settings are not projected: read them from `call.request`.
`params` and the `temperature` / `max_tokens` convenience properties are removed.
A normalized projection can be added as a field if a cross-experiment query
needs one. Fields earn a place when they are normalized projections (`tools`,
`tool_choice`) or not derivable from raw payloads (`agent`); an unnormalized
subset of the raw payload does not. Inspect's `GenerateConfig` remains in its
raw `inspect.event` record, with no copy on `llm.call`.

`agent` is the only ADB-added data field. The shared client uses the string the
backend was constructed with; the Inspect adapter uses the model role when set,
otherwise caller-provided attribution, never a per-sample scope string. Every
Inspect transcript event is emitted raw, followed immediately by `llm.call` for
each model event, including cached events. File-pool references, viewer
tracebacks, streaming state and Inspect's envelope identity remain outside the
boundary payload. Messages and calls are expanded.

**Metadata rule.** `metadata` holds producer notes with producer-prefixed keys,
such as `inspect.cache`, `inspect.sample_id` and `inspect.epoch`. No shared reader
or web view depends on any metadata key. A key wanted by two producers becomes
a field. The viewer does not read metadata.

Capture preserves all available output choices, tool definitions and requests,
multimodal content, detailed usage and provider metadata. `call.request` and
`call.response` contain serialized SDK objects, not exact HTTP bytes. A model's
tool request does not establish that the tool executed. `input_tokens` excludes
cached tokens under Inspect's semantics since 0.3.184; consumers add cache
read/write counts when aggregating input usage. Missing usage is unknown.

A failed request retains its attempted input and error when available. Internal
SDK retries count separately only if individually observed. Completion-time
emission cannot preserve an operation if its process dies awaiting a response.
The shared ChatClient captures the original response before returning text with
think blocks removed; a changed return value sets
`metadata["adb_experiment.returned_text_stripped"] = true` on that call.

## 2. Results

`Result` has `type="result"`, `name: str`, and `value: Scalar`: a finite number,
string or boolean. Its name refers to a manifest result declaration, which owns
the description and units. Series positions belong in custom observations,
such as `govsim.state.resource`, rather than in results.

The runner retains every result event and validates names against the manifest.
An undeclared name or repeated declared name produces a warning log. Consumers
derive the summary from the last result event per declared name, excluding
undeclared names and leaving missing results absent. Consumers also derive call
counts and usage from `llm.call` records alone. `run.end` contains only process
facts: `state`, `duration_s`, and `exit_code`; it carries no derived summary or
usage totals.

## 3. Stream and experiment schemas

The envelope, timestamps, identity, compatibility and frozen-module rules are
specified in [RFC 0002](0002-schema-versioning-identity-and-releases.md).
Optional model values are omitted with `exclude_none=True`; explicit nulls in
open JSON objects retain their meaning. Emission validates the exact serialized
payload it writes.

`CustomEvent` has `type="custom"`, `kind`, and JSON object `data`. Experiments
specialize it with strict data models and literal kinds, exporting a full
`Payload` union discriminated first on `type`, then on custom `kind`.
[GovSim schema 0](../../experiments/govsim/govsim_adapter/models.py) is the first
such union. `read_events(run_dir, payload=Payload)` accepts that type or its
Pydantic `TypeAdapter`; the default shared union reads custom data generically.
Invalid or truncated records raise an error identifying the file and line.

## 4. Deferrals

A concept gets a shared event only when its meaning is fixed by a technical
boundary such as an API call, a process, a file, or a budget, never by an
experiment's science.

Deferred names are `instance`, `artifact`, `agent.event`, `tool.call`,
`span.begin`, `span.end`, `limit`, and raw harness records.
Scientific concepts, including experiment-specific agent actions, remain typed
custom events. Deferred concepts do not add tags to this v0 vocabulary.
