# Credentials — full design (ratified 2026-07-25)

The user-facing MVP subset lives in `docs/book/src/running/secrets.md`. This file is the
complete design the MVP grows into; the invariants at the top are binding now, the
mechanisms below are staged.

## Invariants (binding from day one)

1. **A name is a condition, a key is environment.** Credentials, endpoints, and
   profile selections never enter the condition hash. Any future change to this
   machinery re-buckets nothing.
2. **Nothing ambient.** No env passthrough into experiments — a run's environment is
   constructed: minimal system basics + deliberately injected fields + `ADB_*` run
   vars. Deliberately underspecified basics; VM isolation later replaces them.
3. **Everything asked for.** Secrets enter via the interactive ask (or the store file
   itself, e.g. CI materializing it). Never argv. The ask ends `save? [Y/n]` —
   `n` = this-run-only, held in runner memory.
4. **Recorded, ablated.** Every run records the env var names it received and which
   set/profile served each; secret field values are ablated, non-secret values
   (base URLs, DOCKER_HOST) are kept as covariates.
5. **Secrecy is a per-field attribute**, not a category: resolved as the union of
   declaration flag, template flag, name heuristics (`*_KEY`, `*_TOKEN`), and a
   per-set stored override (secret base URLs are real: proxy URLs embedding tokens,
   webhook-style capability URLs).

## The store

- `~/.config/adb/credentials.toml`, 0600; `$ADB_CREDENTIALS_FILE` override is the CI
  interface. Named **credential sets** = free-form field maps; built-in names
  (openai, anthropic, …) are **prompt templates only** (defaults + which field is
  secret) — no routing semantics.
- **Profiles**: `[openai]` bare, `[openai.work]` alternate. `credentials set
  openai@work` to create; `--cred openai=work` per run to select (repeatable;
  environment, recorded as covariate). Deployment-segment auto-preference
  (`azureai/x` → `azureai@x`) was considered and REJECTED for now (YAGNI).

## Requirements — how a run's needs are computed

Flat and declarative; **no conditional `when`-grammar** (prior art uniformly warns:
JSON Schema if/then, Actions `if:`, systemd Condition*). The ladder:

1. `llm`-typed params route by model-id segment: prefix before the first `/`, or the
   service segment of `openai-api/<service>/<model>` (matches inspect's `<SERVICE>_*`
   env contract; caveat: the service name enters the condition — canonical prefixes
   pool globally, named services are for simultaneous endpoints).
2. Fixed extras: a flat per-experiment declaration, exception-only (default none —
   a generated 100-task family declares nothing):

   ```nix
   credentials = {
     huggingface = {
       required = true;
       fields.HF_TOKEN = { from = "api_key"; secret = true; };
       description = "GPQA's dataset is gated.";
     };
     docker = {
       required = false;   # injected when configured, never prompted
       fields.DOCKER_HOST = { from = "host"; secret = false;
                              default = "unix:///var/run/docker.sock"; };
     };
   };
   ```

   Declarations carry their own field specs (env name, source field, secrecy,
   default, description) — stack knowledge lives with the stack; shared wrapper
   layers (lib/adb-inspect's nix side) export snippets families splice in.
3. Conditionality is served by optional fields (inject-if-present) or by splitting
   experiments (house style: the variant is the experiment) — never by a rule
   language.
4. Reserved, unbuilt: a `--requirements` exec mode on the experiment program
   (params in → needs JSON out) for genuinely dynamic cases; and an exec-command
   field on a credential set for dynamic credentials (AWS credential_process-style,
   Azure Entra tokens, OAuth harness CLIs).

## Delivery

- **Env injection, deliberate**: the set's fields under their stored names
  (conventional), or the declaration's mapping. Only for sets the run routes
  to/declares.
- **The stdin envelope** for wrapper-constructed clients (multi-set, per-agent
  models — the Concordia/multi-Azure case): `{"params": {...}, "credentials":
  {"<model-id verbatim>": {"api_key": ..., "base_url": ...}}}`. Keyed by model id so
  the wrapper does a dumb lookup and learns nothing about sets/profiles/routing.
  Never recorded. (Rejected alternative: `ADB_CRED_<SET>_<FIELD>` env — name
  mangling as contract, and env leaks to all descendants.)
- Harness descriptors (v1) reuse the same field-mapping primitive — their
  `credentials` list is the forwarding manifest across the sandbox boundary.

## MVP cut (what ships first)

Ask-on-first-need + Y/n; `credentials set/list/remove/path` with templates;
credentials.toml (+ file env override); prefix & openai-api routing; conventional
env injection; no-passthrough constructed env with recorded/ablated env.
Deferred: profiles/`--cred`, fixed-extra declarations, the envelope, secret-field
overrides, exec modes. Deferral consequence: gated-dataset tasks (gpqa) can't
receive HF_TOKEN until declarations land — the catalog carries only ungated tasks
until then, or gpqa documents its limitation.
