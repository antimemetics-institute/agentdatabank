import type { Condition } from "../shared/types.ts";

export interface NamedCondition extends Condition { id: string }
export interface Sibling { condition: NamedCondition; key: string; from: unknown; to: unknown }

// JSON structural equality: object insertion order is not a parameter change.
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

export function siblingConditions(anchor: NamedCondition, all: NamedCondition[]): Sibling[] {
  return all.flatMap((candidate) => {
    if (candidate.id === anchor.id || candidate.experiment !== anchor.experiment || candidate.source !== anchor.source) return [];
    const keys = [...new Set([...Object.keys(anchor.params), ...Object.keys(candidate.params)])];
    const changed = keys.filter((key) => stable(anchor.params[key]) !== stable(candidate.params[key]));
    if (changed.length !== 1) return [];
    const key = changed[0]!;
    return [{ condition: candidate, key, from: anchor.params[key], to: candidate.params[key] }];
  }).sort((a, b) => a.key.localeCompare(b.key) || a.condition.id.localeCompare(b.condition.id));
}

export function conditionHref(id: string, pool?: string): string {
  return `#/conditions/${encodeURIComponent(id)}${pool === undefined ? "" : `?${new URLSearchParams({ pool })}`}`;
}
