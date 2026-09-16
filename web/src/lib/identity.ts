/** Execution IDs use a UTC launch label and 48 random bits, never an abbreviation. */
export const RUN_ID_RE = /^[0-9]{8}t[0-9]{6}z-[0-9a-f]{12}$(?![\s\S])/;

/** Derive storage paths from recorded fields; never parse the experiment suffix. */
export function conditionName(condition: string, experiment: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(condition) || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(experiment))
    throw new Error("invalid condition or experiment path component");
  return `${condition}-${experiment}`;
}
