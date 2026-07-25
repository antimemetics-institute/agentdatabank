/* Command-prefs storage + React binding. Deliberately the SAME localStorage key
   and stored shape as the docs gear menu (docs/book/theme/adb-commands.js), so
   when the guide and the webui are served from one origin a choice made in
   either carries to the other; the `storage` event picks up changes made in a
   docs (or second webui) tab live. */

import { useSyncExternalStore } from "react";
import { CMD_PREFS_DEFAULTS, type CmdPrefs } from "./cmd-rewrite.ts";

const KEY = "adb-cmd-prefs";

function load(): CmdPrefs {
  try {
    return { ...CMD_PREFS_DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return { ...CMD_PREFS_DEFAULTS };
  }
}

let cached = load();
const listeners = new Set<() => void>();

export function setCmdPrefs(patch: Partial<CmdPrefs>): void {
  cached = { ...cached, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(cached));
  } catch {
    /* private mode */
  }
  listeners.forEach((l) => l());
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  /* another tab wrote the key (e.key === null is a full storage.clear()) */
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY || e.key === null) {
      cached = load();
      cb();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", onStorage);
  };
}

export function useCmdPrefs(): CmdPrefs {
  return useSyncExternalStore(subscribe, () => cached);
}
