import type { Ev } from "../shared/types.ts";
import { RUN_ID_RE } from "./identity.ts";

/** Validate the envelope boundary without interpreting an experiment's payload. */
export function parseEnvelope(value: unknown): Ev {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Unreadable record: expected an envelope object");
  const row = value as Record<string, unknown>;
  for (const key of ["v", "schema", "seq"])
    if (typeof row[key] !== "number" || !Number.isSafeInteger(row[key]) || row[key] < 0)
      throw new Error(`Unreadable record: envelope.${key} must be a non-negative integer`);
  for (const key of ["ts", "run", "experiment"])
    if (typeof row[key] !== "string") throw new Error(`Unreadable record: envelope.${key} must be a string`);
  if (!Number.isFinite(Date.parse(row.ts as string))) throw new Error("Unreadable record: invalid envelope.ts");
  if (!RUN_ID_RE.test(row.run as string)) throw new Error("Unreadable record: invalid envelope.run");
  const event = row.event;
  if (!event || typeof event !== "object" || Array.isArray(event)
    || typeof (event as Record<string, unknown>).type !== "string"
    || ((event as Record<string, unknown>).kind !== undefined && typeof (event as Record<string, unknown>).kind !== "string"))
    throw new Error("Unreadable record: envelope.event must have a string type and optional string kind");
  return value as Ev;
}

export function parseEventLine(line: string): Ev {
  try { return parseEnvelope(JSON.parse(line)); }
  catch (error) { throw new Error(`Unreadable event line: ${error instanceof Error ? error.message : String(error)}`); }
}
