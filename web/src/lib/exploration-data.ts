import type { RunMeta } from "../shared/types.ts";

type Scalar = string | number | boolean | null;
export type ExplorationRow = Record<string, Scalar>;

// Keep parameters and results separate. Missing observations are null, never zero.
export function explorationRows(runs: RunMeta[], parameters: (run: RunMeta) => Record<string, unknown> | undefined): ExplorationRow[] {
  const scalar = (value: unknown): Scalar =>
    typeof value === "string" || typeof value === "boolean" ? value
      : typeof value === "number" && Number.isFinite(value) ? value : null;
  const rows = runs.map(run => {
    const row: ExplorationRow = {
      run: run.run, condition: run.condition, state: run.state ?? null,
      seed: run.seed ?? null,
    };
    for (const [prefix, values] of [["param_", parameters(run)], ["result_", run.summary]] as const) {
      for (const [key, value] of Object.entries(values ?? {})) row[prefix + key] = scalar(value);
    }
    // Declarations preserve columns even when no run has emitted a value yet.
    for (const { name } of Array.isArray(run.result_definitions) ? run.result_definitions : []) row["result_" + name] ??= null;
    return row;
  });
  const columns = new Set(rows.flatMap(row => Object.keys(row)));
  return rows.map(row => Object.fromEntries([...columns].map(key => [key, row[key] ?? null])));
}
