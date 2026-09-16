import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ElidedMarker, Ev, EventPayload, FullEvent } from "../shared/types.ts";
import { parseEventLine } from "../lib/envelope.ts";

export class UnreadableRecord extends Error {}

/** Keep the original line terminator, whitespace and JSON spelling for raw views. */
export async function readEventRecords(dir: string): Promise<FullEvent[] | null> {
  const files = ["events.jsonl"];
  const records: FullEvent[] = [];
  for (const file of files) {
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await readFile(join(dir, file))); }
    catch (error) { throw new UnreadableRecord(`${file}: ${String(error)}`); }
    const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
    for (const [index, line] of lines.entries()) {
      try { records.push({ record: parseEventLine(line), line }); }
      catch (error) { throw new UnreadableRecord(`${file}:${index + 1}: ${String(error)}`); }
    }
  }
  return records;
}

const marker = (value: unknown): ElidedMarker => ({
  __elided: { bytes: Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value)) },
});

/** List transport only. Only payload fields can be elided; never envelope fields.
 * A consumer needing an elided field must GET event/<seq> for the full disk line.
 * There is no compatibility rewriting of historical payloads or bare records.
 */
export function elideEvent(record: Ev, limit = 4096): Ev {
  const walk = (value: any): any => {
    if (typeof value === "string") return value.length > limit ? marker(value) : value;
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, walk(entry)]));
    return value;
  };
  const event: EventPayload = { ...record.event };
  if (event.type === "llm.call") {
    if (event.input !== undefined) event.input = marker(event.input);
    if (event.call !== undefined) event.call = marker(event.call);
  }
  const elided = walk(event) as EventPayload;
  // The payload discriminator is always available for routing the row.
  elided.type = event.type;
  if (event.kind !== undefined) elided.kind = event.kind;
  return { ...record, event: elided };
}
