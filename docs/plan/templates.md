# Templates: user-space named param presets

Status: DESIGN — not implemented. Emerged from the Concordia family design discussion
(2026-07-26): scenario-shaped experiments need users to define configurations in the
UI, and the canonical-configuration story ("the cafe scene") needs a home that is not
nix code.

## The problem

A generative harness (Concordia; later: any composable simulation) has no upstream
task registry to generate cards from. Its "task" — the cast, the premise — is data
interpreted by one program. Forcing that data into per-scenario nix cards (the first
Concordia port attempt) buys registry legibility at the cost of the harness's whole
point: composing situations. Forcing it into bare params (the prototype) loses the
legibility: no names, no discoverable canonical configurations, run tables that mix
unrelated studies.

The missing object is a **template**: a named, shareable preset of params — created
in the UI, stored as data, never code.

## Where the boundaries land

| Layer | Medium | Boundary rule |
|---|---|---|
| **Experiment** (card) | code, nix | one card per *program* difference: schema, results semantics, wrapped code. inspect tasks are different programs → cards. Concordia scenarios are not → one `concordia` card. |
| **Template** | data, user-space JSON | a named point/region in one experiment's param space ("cafe", "market-haggle"). |
| **Condition** | hash | automatic identity of a complete binding. Unchanged by this design. |

## Principles

1. **Templates are presentation and curation, never identity.** The condition hash
   never sees them. A copied oneliner is always fully explicit. Editing or deleting a
   template re-versions nothing and re-labels nothing retroactively recorded.
2. **Compose-time expansion.** A template fills the composer form (or expands to
   `--set`s); it is never a runtime indirection. A mutable file must not change what a
   previously saved command means.
3. **Content matching, not provenance.** A run *matches* a template iff every param
   the template sets deep-equals the run's realized param. Grouping is computed at
   read time. Consequences worth wanting: a template created *after* runs exist
   immediately labels the old runs; two researchers who never exchanged the template
   file still group together if their spellings agree; a lying label is impossible.
4. **Partial by design.** A template sets only the params it names. A scenario
   template (roster + premise + steps) that leaves `model` open groups runs *across*
   models — the template names the study, the open params are its comparison axes.
   This is the "class of experiments" structure: experiment → templates → conditions.

## Object model

```
$ADB_HOME/templates/<experiment>/<slug>.json
{
  "name": "market-haggle",
  "description": "Buyer and seller haggle over a used bicycle — zone of agreement $60–$90.",
  "experiment": "concordia",
  "params": { "agents": [...], "premise": "...", "game_master": "dialogic", "max_steps": 4 },
  "created": "2026-07-26T12:00:00Z",
  "origin": "user"
}
```

Slug = filename = identity within the local store. `params` is a partial map over the
experiment's schema; values are realized-param JSON (what `--set` would produce).
No `replicates`/`seed` in v1 — a template presets the condition, not the sampling plan.

**Built-in examples** ship as plain JSON files in the experiment's directory
(`experiments/concordia/templates/*.json`) — data files, *excluded from the identity
`src` list*, delivered to the server the way manifests are (a nix linkFarm →
`ADB_WEB_TEMPLATES`). Same format, `origin: "builtin"`. Built-ins seed the picker so
the first-run UX has named scenarios; they are not privileged beyond read-only.

## Lifecycle UX

**Create** — in the composer: fill the form, "save as template…" → name, description,
and a checkbox per param for inclusion (partial templates are how you say "this is a
scenario, model is open"). From a run page: "save as template" seeds the dialog from
the run's realized params — which makes *any published run* one click from becoming a
named, re-runnable study. This is the intro's promised loop (re-run a published
result, change something) made concrete.

**Use** — composer: a template picker above the form (chips with description
tooltips); picking one sets the named fields, leaves the rest. CLI:
`adb-runner template list/show`, and `--template <slug>` merges under explicit
`--set`s (explicit wins) while immediately printing the fully-expanded equivalent
command — the explicit spelling is always the one to publish, same stance as the
bare-invocation hint.

**Share** — v1: it's a file; send it. Roadmap: templates deposit alongside runs
(they are tiny JSON), and the public index aggregates matches by content — canonical
scenarios emerge by *adoption*, not by PR gatekeeping. Namespacing (author-qualified
names) is a deposit-time concern, deferred.

**Evolve** — editing a template is editing a file; because grouping is content-based,
labels follow the spelling automatically and old runs keep matching the spelling they
actually ran.

## GUI surfaces

- **Composer**: picker + save dialog (above).
- **Experiment page**: runs table gains template chips (content-match); filter by
  template. With templates present, the page reads as experiment → named scenarios →
  runs, which is the legibility the per-scenario cards were buying — recovered
  without minting code-level identity.
- **Overview**: the experiment card may show a template count ("concordia · 4
  scenarios"). Per-template run counts come free from matching.

## Server

The web server today is a read-only pipe over `$ADB_HOME`. Templates add its first
write surface: `GET /api/templates`, `PUT/DELETE /api/templates/<experiment>/<slug>`
writing under `$ADB_HOME/templates/`. This is a deliberate, narrow departure: still
file-per-artifact, still no server-side logic, still local-only — the server stays a
pipe, just bidirectional for this one artifact class. (Rejected alternative: browser
localStorage — invisible to the CLI, undepositable, dies with the profile.)

## Consequences for Concordia (implementation order, after sign-off)

1. Collapse `concordia-cafe`/`concordia-market-haggle` into one `concordia`
   experiment: `agents` (listOf struct — the composer's table editor already exists),
   `premise`, `game_master` (str + prefab suggestions), `max_steps`, `model`,
   `temperature`, `max_tokens`; initials = the cafe scene, keyless on `mock/model`.
2. Ship `templates/cafe.json` + `templates/market-haggle.json` as built-ins.
3. mkExperiment stays untouched (templates deliberately do NOT enter the manifest or
   any nix declaration).
4. Server template endpoints + composer picker/save + run-page "save as template" /
   "open in composer".
5. Docs: catalog/concordia.md rewritten around one card + templates; a short
   "Templates" section in the running chapter.

## Open questions

- Name collision between a user template and a builtin (refuse? shadow with badge?).
- Should a run *optionally* record "composed from template X" as a provenance
  covariate? Additive later; matching stays content-based regardless.
- Most-specific-match display when a run matches several templates (subset templates
  nest — probably show all, sorted by specificity).
- Whether `--template` at run time survives purist review, or becomes compose-only
  (`template expand` printing a command). v1 keeps it with the expansion print.
- Do templates generalize to sweep specs (the prototype's ~dist values)? Out of
  scope here; the format doesn't preclude it.
