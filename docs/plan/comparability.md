# Comparability & advisories (future)

Status: **not built — deliberately.** This note records the design direction and
what the MVP already guarantees so the door stays open; the full model is
specified in the prototype:
`agentdatabank-prototype/docs/plan/specs/comparability.md`.

## The posture

Identity and comparability are separate layers, and the separation is the design:

- **Identity records, never judges.** A condition's `source` is a strict content
  hash of the experiment's declared sources (declaration + env pin). Any change —
  harmless or breaking — mints new condition ids. Identity deliberately
  over-fragments; it never encodes anyone's opinion about whether a change
  mattered. (This is why upstream's per-eval comparability version is *not* part
  of identity: an upstream behavior change without a version bump would mint the
  same id for behaviorally different runs — a conflation no later overlay can
  undo. Over-fragmentation is recoverable; conflation is not.)
- **Comparability is a revisable read-time overlay.** The default analysis view
  pools by `(experiment, params)` across source versions, so harmless boundaries
  cost nothing to cross. Genuine breaks are expressed as dated, scoped,
  append-only **advisories** — predicates over `(experiment, params, recorded
  covariates)` — of three kinds: **yank** (version is wrong; exclude it, bridge
  the hole), **split** (behavior changed; separate populations), **group**
  (re-join populations across a split). Populations are connected components of
  the edited graph, derived at read time, never stored.

## What the MVP already guarantees (the part that can't be added retroactively)

- **Strict per-experiment content identity** — `mkExperiment src`
  (pkgs/build-support/default.nix); a family's pin bump re-versions the family
  together, and a run's `fetch_ref` is recorded separately for reproduction.
- **The covariate obligation** — the inspect wrapper records the exact
  `inspect_ai`/`inspect_evals` versions, the task version, and the dataset
  identity per run (lib/adb-inspect/adb_inspect/translate.py). An advisory can
  only scope on a fact recorded before anyone knew it mattered.
- **The advisory seed** — `task tasks:update` diffs each eval's *declared*
  comparability version against the previous catalog and prints every bump as a
  split-advisory candidate. Today that's a release note on stdout; nothing is
  stored or applied.

## Decided for v1: the model axis groups by reported model

Every `llm.call` records the model the provider *reported serving*
(`response.model`) next to the requested id. When pooled analysis views land,
the default model axis groups runs by the reported model — falling back to the
requested param where no report exists, never silently substituting, and
always surfacing runs where the two disagree. This is what re-unifies an
undated alias with its dated snapshot, and two orgs' Azure deployment names
with each other and with `openai/` runs of the same model. Caveats to honor:
the report is provider self-report (a local server says whatever it was
launched as), and the wrapper must be checked per provider for copying the
request into the output instead of the server's echo.

## What v1 would add

- An append-only, maintainer-signed advisory store (git-native, RustSec-shaped):
  one YAML statement per judgment, `yank | split | group`, with scope, reason,
  date.
- Read-time pooling in analysis views: compose the advisory set, derive
  populations, aggregate each with its own n and the boundary's reason attached.
  Removing an advisory file re-derives the view; deposits are never touched.
- Optionally: `tasks:update` drafting the advisory files themselves from the
  comparability diff, leaving the maintainer to edit reasons and commit.

Until then: keep recording covariates, keep the diff printout honest, and write
nothing else down — the overlay can be added whenever it's needed precisely
because identity never tried to do its job.
