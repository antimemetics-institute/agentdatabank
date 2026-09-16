/* Reader checks, not migrations. Original metadata is always available verbatim. */
import { RUN_ID_RE } from "./identity.ts";
import type { ResultDecl, RunCard, RunMeta } from "../shared/types.ts";

export const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function oneLineReason(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim() || "Unknown read error";
}

export function isResultDeclaration(value: unknown): value is ResultDecl {
  return object(value) && typeof value.name === "string" && !!value.name
    && object(value.type) && typeof value.type.kind === "string"
    && ["label", "description", "details", "unit"].every((key) => value[key] === undefined || typeof value[key] === "string");
}

/** A foreign declaration container has no declared names; never iterate it. */
export function resultDeclarations(value: unknown): ResultDecl[] {
  return Array.isArray(value) ? value.filter(isResultDeclaration) : [];
}

export function resultDeclarationsReason(value: unknown): string | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) return "result_definitions must be an array";
  const bad = value.findIndex((entry) => !isResultDeclaration(entry));
  return bad < 0 ? null : `result_definitions[${bad}] is not a result declaration`;
}

export function metadataReason(value: unknown, identity?: { run: string; condition: string }): string | null {
  if (!object(value)) return "run.json: expected an object";
  for (const key of ["run", "condition", "experiment"] as const) {
    if (typeof value[key] !== "string" || !value[key]) return `run.json: ${key} must be a non-empty string`;
    if (key !== "experiment" && identity && value[key] !== identity[key])
      return `run.json: ${key} does not match its directory`;
  }
  if (!RUN_ID_RE.test(value.run as string)) return "run.json: invalid run ID";
  if (!["provisioning", "running", "completed", "failed", "interrupted"].includes(value.state as string))
    return "run.json: state is missing or unsupported";
  for (const key of ["started_at", "finished_at", "heartbeat_at"])
    if (value[key] !== undefined && (typeof value[key] !== "string" || !Number.isFinite(Date.parse(value[key]))))
      return `run.json: ${key} must be a timestamp string`;
  for (const key of ["seed", "duration_s"])
    if (value[key] !== undefined && (typeof value[key] !== "number" || !Number.isFinite(value[key])))
      return `run.json: ${key} must be a finite number`;
  for (const key of ["source", "fetch_ref", "tree_hash"])
    if (value[key] != null && typeof value[key] !== "string") return `run.json: ${key} must be a string`;
  for (const key of ["params", "runtime"])
    if (value[key] !== undefined && !object(value[key])) return `run.json: ${key} must be an object`;
  if (object(value.runtime) && value.runtime.endpoints !== undefined
    && (!object(value.runtime.endpoints) || !Object.values(value.runtime.endpoints).every((origin) => typeof origin === "string")))
    return "run.json: runtime.endpoints must map provider names to strings";
  const declarations = resultDeclarationsReason(value.result_definitions);
  return declarations ? `run.json: ${declarations}` : null;
}

/** Validate the card, not a historical flat metadata format. */
export function cardReason(value: unknown): string | null {
  if (!object(value)) return "run.json: expected an index card";
  for (const section of ["identity", "inputs", "lifecycle", "provenance", "definitions", "derived"])
    if (!object(value[section])) return `run.json: ${section} must be an object`;
  const card = value as unknown as RunCard;
  const reason = metadataReason(cardMeta(card));
  if (reason) return reason;
  if (!Number.isSafeInteger(card.identity.schema) || card.identity.schema < 0) return "run.json: identity.schema must be a non-negative integer";
  if (!object(card.inputs.params)) return "run.json: inputs.params must be an object";
  if (!Number.isSafeInteger(card.inputs.seed) || card.inputs.seed < 0) return "run.json: inputs.seed must be a non-negative integer";
  if (typeof card.provenance.source !== "string" || !object(card.provenance.runtime)) return "run.json: invalid provenance";
  if (!Array.isArray(card.definitions.results)) return "run.json: definitions.results must be an array";
  const derived = card.derived;
  if (!object(derived.results) || !object(derived.usage) || !object(derived.counts)) return "run.json: invalid derived block";
  if (!Array.isArray(derived.served_models) || !derived.served_models.every((model) => typeof model === "string"))
    return "run.json: derived.served_models must be an array of strings";
  const counts = derived.counts;
  if (!object(counts.by_kind) || !object(counts.llm_calls_by_agent)) return "run.json: invalid derived counts";
  for (const value of [counts.llm_calls, counts.failed_calls,
    ...Object.values(counts.by_kind), ...Object.values(counts.llm_calls_by_agent), derived.usage.input_tokens, derived.usage.output_tokens, derived.last_seq])
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return "run.json: derived counters must be non-negative integers";
  if (typeof derived.last_event_at !== "string" || !Number.isFinite(Date.parse(derived.last_event_at))) return "run.json: invalid derived.last_event_at";
  if (derived.last_status !== undefined && typeof derived.last_status !== "string") return "run.json: invalid derived.last_status";
  return null;
}

/** Copy card values into the existing UI DTO; no stream aggregation or input binding. */
export function cardMeta(card: RunCard): RunMeta {
  return { ...card.identity, ...card.inputs, ...card.lifecycle, ...card.provenance,
    result_definitions: card.definitions.results, summary: card.derived.results, derived: card.derived };
}
