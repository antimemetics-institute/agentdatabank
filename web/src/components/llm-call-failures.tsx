import type { Ev } from "../shared/types";

/** Observed call failures, independent of process state or result validity. */
export function LLMCallFailures({ events }: { events: Ev[] }) {
  let calls = 0;
  let failures = 0;
  for (const event of events) {
    if (event.type !== "llm.call") continue;
    calls += 1;
    if (event.error != null) failures += 1;
  }
  if (failures === 0) return null;
  return (
    <span className="text-sm font-medium text-destructive">
      {failures}/{calls} model calls failed
    </span>
  );
}
