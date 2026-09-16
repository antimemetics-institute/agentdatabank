import type { Ev, EventPayload } from "../src/shared/types.ts";

export const envelope = (event: EventPayload, seq = 0, ts = "2026-09-16T12:00:00.000000Z"): Ev => ({
  v: 0, ts, run: "20260916t120000z-012345abcdef", experiment: "example", schema: 0, seq, event,
});

import type { RunCard } from "../src/shared/types.ts";
import { runSummary, runUsage } from "../src/lib/run-view.ts";
import { eventKind } from "../src/lib/render-hints.ts";
import { cardMeta } from "../src/lib/run-readability.ts";

/** Independent test projection; production summary views consume the runner's card. */
export function fixtureCard(events: Ev[]): RunCard {
  const first = events[0] ?? envelope({ type: "run.start" });
  const start: EventPayload = events.find(e => e.event.type === "run.start")?.event ?? { type: "run.start" };
  const end = events.find(e => e.event.type === "run.end");
  const last = events.at(-1) ?? first;
  const usage = runUsage(events);
  const byKind = new Map<string, number>(), callsByAgent = new Map<string, number>();
  for (const record of events) {
    const kind = eventKind(record);
    byKind.set(kind, (byKind.get(kind) ?? 0) + 1);
    const { type, agent } = record.event;
    if (type === "llm.call" && typeof agent === "string")
      callsByAgent.set(agent, (callsByAgent.get(agent) ?? 0) + 1);
  }
  return {
    identity: { run: first.run, condition: start.condition ?? "condition", experiment: first.experiment, schema: first.schema },
    inputs: { params: start.params ?? {}, seed: start.seed ?? 1 },
    provenance: { source: start.source ?? "test-source", runtime: start.runtime ?? {},
      ...(start.fetch_ref !== undefined ? { fetch_ref: start.fetch_ref } : {}),
      ...(start.tree_hash !== undefined ? { tree_hash: start.tree_hash } : {}) },
    definitions: { results: start.result_definitions ?? [] },
    lifecycle: { state: end?.event.state ?? "running", started_at: first.ts,
      ...(end ? { finished_at: end.ts, duration_s: end.event.duration_s ?? 0, exit_code: end.event.exit_code ?? 0 } : {}) },
    derived: { results: runSummary(events, start.result_definitions),
      usage: { input_tokens: usage.input, output_tokens: usage.output },
      counts: { llm_calls: usage.calls, failed_calls: usage.failed,
        by_kind: Object.fromEntries(byKind), llm_calls_by_agent: Object.fromEntries(callsByAgent) },
      last_seq: last.seq, last_event_at: last.ts,
      ...(events.some(e => e.event.type === "status") ? { last_status: [...events].reverse().find(e => e.event.type === "status")!.event.detail } : {}) },
  };
}
export const fixtureMeta = (events: Ev[]) => ({ ...cardMeta(fixtureCard(events)), heartbeat_at: events.at(-1)?.ts });
