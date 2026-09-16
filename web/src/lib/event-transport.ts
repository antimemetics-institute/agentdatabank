import type { ElidedMarker, Ev } from "../shared/types.ts";

export const isElided = (value: unknown): value is ElidedMarker => {
  if (!value || typeof value !== "object" || !Object.hasOwn(value, "__elided")) return false;
  const marker = (value as { __elided: unknown }).__elided;
  return !!marker && typeof marker === "object" && typeof (marker as { bytes?: unknown }).bytes === "number";
};
export function containsElision(value: unknown): boolean {
  if (isElided(value)) return true;
  if (Array.isArray(value)) return value.some(containsElision);
  return !!value && typeof value === "object" && Object.values(value).some(containsElision);
}

/** Request/input are opened on demand. All other displayed fields need real data. */
export function needsDisplayRecord(record: Ev): boolean {
  return Object.entries(record.event).some(([key, value]) =>
    !(record.event.type === "llm.call" && (key === "input" || key === "call")) && containsElision(value));
}
