# GovSim

Can a group of AI agents share a resource without exhausting it?

![Five agents discuss catch limits around a shared lake. Leaving enough fish allows recovery; taking too many depletes the stock.](overview.svg)

GovSim puts language-model agents in a small society where each agent benefits
from taking a shared resource, but taking too much threatens everyone's future.
In the fishing scenario, for example, agents decide how many fish to catch from
a lake. They can discuss their catches and agree on limits, but each agent still
chooses its own actions.

The experiment comes from [Cooperate or Collapse](https://arxiv.org/abs/2404.16698)
(Piatti et al., NeurIPS 2024). The [GovSim source](https://github.com/giorgiopiatti/GovSim)
contains the original simulation.

## What happens in a run?

Each round represents a month. Agents harvest, observe what others did, discuss
how to manage the resource, and reflect on their experience. The resource can
recover between rounds if enough remains.

The scenarios cover fishing, sheep grazing, and pollution. Variants test what
changes when agents cannot discuss their actions, when a profit-seeking outsider
joins, or when agents are prompted to consider what would happen if everyone
acted as they did. Fishing also has variants with reworded prompts.

## What to look for

Watch whether agents agree on limits, follow those agreements, and leave enough
resource for later rounds. Model calls and resource updates appear during the
run; the group conversation is added after the simulation finishes.

**Resource collapse is a simulation outcome, not an execution failure.**
`collapsed = false` means no collapse was recorded during the run. A short run
without collapse does not establish that cooperation would last.

Results describe how long the resource survived, how much agents collected,
how evenly they shared it, and how much remained. Equality alone is not success:
agents who all collect nothing are also equal.

The runner records launch parameters, seeds, source references and build
information in `run.json` and `run.start`. GovSim adds its resolved configuration
as `govsim.config` and every upstream simulation-log row under an action kind:
`govsim.harvest`, `govsim.utterance`, `govsim.summary`, or `govsim.resource_limit`.
Unrecognized actions remain `govsim.record`. These custom
events preserve the original fields, including interaction HTML and nulls.
Schema render hints label each row in sequence; facet filters narrow the stream.
Summary interactions retain their original HTML on disk; the viewer strips tags
and displays plain text. The resource series is `govsim.state.resource`.
GovSim exports no artifact events; upstream working files are implementation details.

Record timestamps reflect post-run ingestion, not when agents acted. Each
`log_env.json` or `persona_N/nodes.json` file has one `govsim.upstream_log` marker
before its rows: `source` is relative to the storage directory, `bytes` and
`sha256` describe the original file bytes, and `records` counts ingested records.
Environment rows retain their own round fields; there are no synthetic round
or replay boundary events. Each node becomes `govsim.memory` with its `persona`
ID and untouched `node`; the viewer shows the persona, node type and description.
Embeddings are not ingested: they are recomputable from node text and the
configured embedder (recorded as `govsim.config.data.embedder`).

On failure, available environment and memory checkpoints are still ingested.
Malformed files get a marker with zero ingested records and their text in
`govsim.unparsed_log`. Missing files get an `unparsed_log` diagnostic with empty
text, since there are no bytes to hash. Other files are captured before the
error fails the run.

Model calls identify personas by their upstream IDs (`persona_N`). Framework calls
use `framework/summarize_conversation`, `framework/find_harvesting_limit`, or
`framework/text_to_triple`; `govsim.phase` and `govsim.query` metadata retain the
upstream context. Replay rows keep their original IDs and names. The config hint declares
the persona roster as an actor registry, so the viewer labels silent personas too.
Per-row labels are applied after roster labels; IDs remain visible on hover. The Mayor's utterances are templated framework output with no model call
behind them.

The packaged upstream source includes a small `seed.patch`: each scenario
passes the effective run seed to environment reset, and perturbation environments
forward it to the resource-allocation RNG. This makes random allocation under
contention repeatable for the same seed and actions. It does not guarantee that
a hosted model will produce identical actions on repeated runs.

## Choosing settings

Use a real model and the `mxbai` memory embedder to explore model behavior.
`mock/model` gives scripted replies, and `hash` gives artificial memory
similarities; both are for testing the workflow.

A one-round run is a quick demonstration. Set `max_rounds` to `0` to use the
scenario's full length: normally 12 months, or 15 for outsider scenarios.

These runs are not automatically reproductions of the paper's results. In
particular, `mxbai` downloads model weights whose revision is not pinned.
The `over_usage` result measures how often agents request more than their
sustainable share; its calculation uses the current number of harvesters, which
differs from the original simulation's fixed count when an outsider joins.
