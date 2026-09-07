# Experiment manifest

A manifest is generated JSON describing an experiment's inputs and presentation. The runner uses it for validation, credential discovery and summary selection; the local interface uses it to build the parameter form.

Read a packaged manifest with:

```sh
nix run .#inspect-hello -- --describe
```

## Top-level fields

| Field | Meaning |
| --- | --- |
| `schema_version` | Currently `0`. |
| `name` | Unique experiment name and app name. |
| `summary` | Short description shown in the interface. |
| `params` | Object mapping parameter names to declarations. Every key must be bound for a run. |
| `results` | Object mapping summary metric names to type descriptors. The runner selects the last emitted value for each declared name that occurred. |
| `env` | Optional experiment metadata. It does not cause the runner to inject arbitrary variables or provision services. |
| `origin` | Packaging repository reference, separate from a run's pinned fetch reference. |
| `links` | External references, each with `label` and `url`, displayed on experiment and run pages when the manifest is available. |

The source identity and executable are wrapper settings, not manifest fields. [`adb.mkExperiment`](../authoring/experiments.md) takes `name`, `summary`, `params`, `program` and `src`, with optional `results`, `env` and `links`.

## Parameter declarations

Each entry of `params` contains `type` plus optional fields:

| Field | Meaning |
| --- | --- |
| `initial` | Initial form value and CLI suggestion. It is never an implicit run-time parameter default. |
| `description` | Explanation shown alongside the input. |
| `nullable` | Permit explicit JSON null; default false. |
| `order` | Presentation order, lower first; default `100`, with name breaking ties. |
| `group` | Form section label. |
| `suggestions` | Suggested strings or `{ "value": STRING, "description": STRING }` entries. Suggestions do not restrict legal values. |
| `minLen`, `maxLen` | List-length bounds checked before execution on realized values. |
| `fields` | Named parameter declarations for a structured object editor. The runner still validates an `object` as free-form JSON. |
| `depends_on`, `variants` | Form metadata selecting a field set using another parameter's value. No in-tree manifest currently produces this variant form. |

LLM-typed parameters receive shared model suggestions during manifest generation. This also applies to LLM fields inside lists of structures. Experiment-specific suggestions are prepended to the shared suggestions.

## Type descriptors

| Nix constructor | JSON descriptor | Accepted value |
| --- | --- | --- |
| `adb.types.str` | `{ "kind": "str" }` | String |
| `adb.types.llm` | `{ "kind": "llm" }` | Model-ID string; also participates in credential discovery |
| `adb.types.int` | `{ "kind": "int" }` | Integer, excluding booleans |
| `adb.types.float` | `{ "kind": "float" }` | JSON number, excluding booleans |
| `adb.types.bool` | `{ "kind": "bool" }` | Boolean |
| `adb.types.enum values` | `{ "kind": "enum", "values": [...] }` | One declared value |
| `adb.types.listOf type` | `{ "kind": "list", "of": TYPE }` | Array whose elements match `TYPE` |
| `adb.types.struct fields` | `{ "kind": "struct", "fields": {...} }` | Object with exactly the declared keys and matching field types |
| `adb.types.object` | `{ "kind": "object" }` | JSON object with arbitrary keys and values |

Use `listOf (struct {...})` for the row-and-column editor, with scalar fields. A structure field can be a bare type descriptor or a wrapper containing `type`, `description` and `suggestions`. `param type attrs` attaches parameter metadata in Nix.

For example:

```nix
with adb.types; {
  agents = param (listOf (struct {
    name = str;
    model = param llm { description = "Model for this agent."; };
  })) {
    minLen = 1;
    description = "One row per agent.";
  };
}
```

## What does validation establish?

The runner rejects unknown and missing parameter keys, then checks value types before hashing the condition. It checks realized values again before executing, including list-length bounds. Specified and realized parameters are currently identical; no distribution or sweep syntax is implemented.

Validation does not verify model existence, credentials, endpoint access or semantic constraints that only the experiment understands. Result type descriptors do not validate emitted metrics against the result declaration; standard metric payloads have their own [scalar-value rule](events.md#metrics).
