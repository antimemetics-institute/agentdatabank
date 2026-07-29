/* Builder draft persistence — pure and node-testable, no React. Two concerns:
   (1) per-experiment drafts: what you set in "configure a run" survives
   navigating away and back (keyed by experiment name, user edits only — never
   the materialized defaults); (2) the last llm value entered anywhere, which
   seeds the model field of the next fresh form. localStorage-backed with an
   in-memory fallback (node tests, private mode). */

const DRAFTS_KEY = "adb-run-drafts";
const LAST_LLM_KEY = "adb-last-llm";

const mem = new Map<string, string>();
const store = {
  get(k: string): string | null {
    try { return localStorage.getItem(k); } catch { return mem.get(k) ?? null; }
  },
  set(k: string, v: string): void {
    try { localStorage.setItem(k, v); } catch { mem.set(k, v); }
  },
};

function loadAll(): Record<string, unknown> {
  try {
    const all: unknown = JSON.parse(store.get(DRAFTS_KEY) ?? "{}");
    return all && typeof all === "object" ? (all as Record<string, unknown>) : {};
  } catch { return {}; }
}

export function loadDraft(name: string): Record<string, string> {
  const d = loadAll()[name];
  if (!d || typeof d !== "object") return {};
  /* a hand-edited or stale blob may hold non-strings — drop them, the form's
     value contract is strings throughout */
  return Object.fromEntries(
    Object.entries(d).filter(([, v]) => typeof v === "string"),
  ) as Record<string, string>;
}

/* an empty draft deletes the entry — reset leaves no residue */
export function saveDraft(name: string, vals: Record<string, string>): void {
  const all = loadAll();
  if (Object.keys(vals).length) all[name] = vals;
  else delete all[name];
  store.set(DRAFTS_KEY, JSON.stringify(all));
}

export function clearDraft(name: string): void {
  saveDraft(name, {});
}

export function getLastLlm(): string {
  return store.get(LAST_LLM_KEY) ?? "";
}

/* every keystroke in an llm field lands here — last full value wins, empties
   are ignored so clearing a field never erases the remembered model */
export function setLastLlm(v: string): void {
  if (v) store.set(LAST_LLM_KEY, v);
}
