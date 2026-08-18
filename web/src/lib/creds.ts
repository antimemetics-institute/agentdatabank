/* Browser-side mirror of the runner's credential ROUTING (credentials.py): which
   credential sets a composed run's model ids route to, which profile the CLI ladder
   would preselect, and which prompt rows a set's form shows. Pure and node-testable.

   Mirrored logic only — never mirrored DATA: the provider registry and the mock
   prefixes arrive on the wire in CredsInfo (from the same `credentials list --json`
   the picker reads), so the runner stays the single source of truth for names.
   Secrets never appear here in any form: the store this module sees is masked
   (secret values are literal `true`). */

import type { CredsInfo, Manifest, ParamDecl, ParamType, ProviderRow, StructField } from "@/shared/types";

/* section_for: the credential set a model id routes to — the provider prefix before
   the first `/`; for inspect's OpenAI-compatible services (`openai-api/<service>/
   <model>`) the *service* segment; mocks route nowhere. */
export function sectionFor(modelId: string, mockPrefixes: string[]): string | null {
  const slash = modelId.indexOf("/");
  if (slash <= 0) return null;
  const head = modelId.slice(0, slash);
  if (mockPrefixes.includes(head)) return null;
  if (head === "openai-api") {
    const service = modelId.slice(slash + 1).split("/")[0];
    return service || null;
  }
  return head;
}

/* a struct field is a bare type descriptor or a param-wrapped one carrying hints —
   same normalization the form applies (builder.tsx fieldDecl) */
const fieldType = (f: StructField): ParamType => ("kind" in f ? f : (f as { type: ParamType }).type);

/* _iter_model_ids: every model-id string at an `llm`-typed position of a (parsed)
   value — bare llm, listOf llm, structs/lists nesting llm */
function* iterModelIds(value: unknown, tdesc: ParamType | undefined): Generator<string> {
  if (!tdesc) return;
  if (tdesc.kind === "llm") {
    if (typeof value === "string" && value) yield value;
  } else if (tdesc.kind === "list" && Array.isArray(value)) {
    for (const item of value) yield* iterModelIds(item, tdesc.of);
  } else if (tdesc.kind === "struct" && value && typeof value === "object") {
    for (const [fname, f] of Object.entries(tdesc.fields ?? {}))
      if (fname in (value as Record<string, unknown>))
        yield* iterModelIds((value as Record<string, unknown>)[fname], fieldType(f));
  }
}

/* the form's value strings are what the runner will JSON-parse; parse the same way
   (bare string fallback) so routing sees the values the run will see */
function parsedVal(raw: string, kind: string): unknown {
  if (kind === "llm") return raw;
  if (kind === "list" || kind === "struct" || kind === "object") {
    try { return JSON.parse(raw); } catch { return undefined; }
  }
  return undefined; /* other scalars can't hold model ids */
}

/* sets_used: the credential sets referenced by the composed run's llm-typed values
   (mocks excluded), in stable order */
export function setsUsed(
  manifest: Manifest,
  effVals: Record<string, string>,
  mockPrefixes: string[],
): string[] {
  const used = new Set<string>();
  for (const [name, decl] of Object.entries(manifest.params) as [string, ParamDecl][]) {
    const raw = effVals[name];
    if (raw === undefined || raw === "") continue;
    for (const id of iterModelIds(parsedVal(raw, decl.type.kind), decl.type)) {
      const section = sectionFor(id, mockPrefixes);
      if (section) used.add(section);
    }
  }
  return [...used].sort();
}

/* _template_rows: the prompt rows for a set's form — the registry template for a
   built-in (on the wire), else the named-set convention (<PREFIX>_API_KEY /
   <PREFIX>_BASE_URL, exactly what openai-api/<name>/<model> ids read) */
export function templateRows(set: string, creds: CredsInfo): ProviderRow[] {
  const builtin = creds.providers[set];
  if (builtin) return builtin;
  const prefix = set.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase();
  return [
    { key: `${prefix}_API_KEY`, secret: true, default: "" },
    { key: `${prefix}_BASE_URL`, secret: false, default: "" },
  ];
}

/* the ladder's preselection, minus the conversation: remembered choice (if it still
   exists) → `default` → the lone profile → null (the select starts empty and the
   run gates until a choice or a new profile exists) */
export function initialProfile(creds: CredsInfo, experiment: string, set: string): string | null {
  const profiles = Object.keys(creds.store[set] ?? {});
  const remembered = creds.prefs[experiment]?.[set];
  if (remembered && profiles.includes(remembered)) return remembered;
  if (profiles.includes("default")) return "default";
  if (profiles.length === 1) return profiles[0]!;
  return null;
}

/* an unconfigured BUILT-IN set can only fail keyless — the run gates on it (the
   runner's missing_sets rule); an unknown prefix may legitimately need nothing */
export const needsSetup = (set: string, creds: CredsInfo): boolean =>
  set in creds.providers && !(set in creds.store);
