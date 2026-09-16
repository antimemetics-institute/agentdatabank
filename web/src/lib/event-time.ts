import type { Ev } from "../shared/types.ts";

export type GutterMode = "absolute" | "relative";
export type GutterInfo = { label: string; unchanged: number; title: string };

function timestamp(value: unknown): bigint | null {
  if (typeof value === "number" && Number.isFinite(value))
    return BigInt(Math.round((value < 1e12 ? value * 1000 : value) * 1000));
  if (typeof value !== "string") return null;
  if (/^\d+$/.test(value)) return timestamp(Number(value));
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  const fraction = value.match(/\.(\d+)/)?.[1]?.padEnd(6, "0").slice(0, 6) ?? "000000";
  return BigInt(ms) * 1000n + BigInt(fraction.slice(3));
}

function offset(us: bigint): string {
  const sign = us < 0 ? "-" : "+";
  if (us < 0) us = -us;
  const seconds = us / 1000000n;
  return `${sign}${String(seconds / 3600n).padStart(2, "0")}:${String(seconds / 60n % 60n).padStart(2, "0")}:${String(seconds % 60n).padStart(2, "0")}.${String(us % 1000000n).padStart(6, "0")}`;
}

export function buildGutters(events: Ev[], mode: GutterMode, startTs?: unknown): Map<unknown, GutterInfo> {
  const gutters = new Map<unknown, GutterInfo>();
  let start = timestamp(startTs);
  let previous: bigint | null = null;
  let previousLabel = "";
  for (const event of events) {
    const us: bigint | null = timestamp(event.ts) ?? previous;
    start ??= us;
    previous = us;
    let label = "--:--:--.------";
    let title = `seq ${String(event.seq)}`;
    if (us !== null && start !== null) {
      const iso = new Date(Number(us / 1000n)).toISOString().slice(0, 19)
        + `.${String(us % 1000000n).padStart(6, "0")}Z`;
      const rel = offset(us - start);
      label = mode === "absolute" ? iso.slice(11, -1) : rel;
      title = `${iso} · ${rel} from run start · seq ${String(event.seq)}`;
    }
    let unchanged = 0;
    while (unchanged < label.length && label[unchanged] === previousLabel[unchanged]) unchanged++;
    gutters.set(event.seq, { label, unchanged, title });
    previousLabel = label;
  }
  return gutters;
}
