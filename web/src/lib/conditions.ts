import type { Condition, RunMeta } from "../shared/types.ts";
import { object } from "./run-readability.ts";

export interface NamedCondition extends Condition { id: string }
export interface Sibling { condition: NamedCondition; key: string; from: unknown; to: unknown }

// JSON structural equality: object insertion order is not a parameter change.
export function parameterIdentity(value: unknown): string {
  if (object(value) && object(value.__param_ref) && typeof value.__param_ref.hash === "string")
    return `hash:${value.__param_ref.hash}`;
  if (Array.isArray(value)) return `[${value.map(parameterIdentity).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${parameterIdentity(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

export function groupConditions(runs: RunMeta[]): NamedCondition[] {
  const groups = new Map<string, NamedCondition>();
  for (const run of runs) {
    if (!groups.has(run.condition) && typeof run.source === "string" && object(run.params))
      groups.set(run.condition, { id: run.condition, experiment: run.experiment, source: run.source, params: run.params });
  }
  return [...groups.values()];
}

export function siblingConditions(anchor: NamedCondition, all: NamedCondition[]): Sibling[] {
  return all.flatMap((candidate) => {
    if (candidate.id === anchor.id || candidate.experiment !== anchor.experiment || candidate.source !== anchor.source) return [];
    const keys = [...new Set([...Object.keys(anchor.params), ...Object.keys(candidate.params)])];
    const changed = keys.filter((key) => parameterIdentity(anchor.params[key]) !== parameterIdentity(candidate.params[key]));
    if (changed.length !== 1) return [];
    const key = changed[0]!;
    return [{ condition: candidate, key, from: anchor.params[key], to: candidate.params[key] }];
  }).sort((a, b) => a.key.localeCompare(b.key) || a.condition.id.localeCompare(b.condition.id));
}

export function conditionHref(id: string, pool?: string): string {
  return `#/conditions/${encodeURIComponent(id)}${pool === undefined ? "" : `?${new URLSearchParams({ pool })}`}`;
}
