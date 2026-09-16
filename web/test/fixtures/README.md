`govsim-mock-events.jsonl` contains all 197 unmodified JSONL lines of the two-round
mock GovSim review run `20260916t195501z-eda65ed6a03a` (schema 0). It covers
lifecycle, config, state, model calls, every native row action, file-ingestion
markers, all five personas' memory nodes, and results. `govsim.state.resource`
is the resource series; the removed duplicate pool event is absent.

`govsim-schema.json` is the build-time export of `govsim_adapter.models:Payload`
for that review. The render guard compares it to the current Nix build when
`ADB_TEST_MANIFESTS` is set. Refresh it with `python -m adb_events.export
govsim_adapter.models:Payload` in the GovSim environment when hints change.
Focused render tests also load `lib/adb-events/tests/fixtures/llm-call.json`
for reasoning and tool calls.
