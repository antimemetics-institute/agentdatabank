/* App shell: left sidebar navigation + hash router (hand-rolled hook, no router
   dependency). Routes: #/ overview, #/experiments/<name>, #/runs, #/runs/<rid>
   (the canonical run link — bare run id → resolver), and #/run/<cid>/<rid> (the
   resolved detail route). The shell is h-screen; list pages scroll in <main>, the
   run page manages its own inner scrolling (fixed head/tabs, scrollable panes). */

import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { Sidebar } from "@/components/sidebar";
import { OverviewPage } from "@/pages/overview";
import { ExperimentPage } from "@/pages/experiment";
import { RunResolver, RunsPage } from "@/pages/runs";
import { RunPage } from "@/pages/run";
import { DevDiagramsPage } from "@/pages/dev-diagrams";
import { widgets } from "@/widget";

if (widgets.length) console.debug(`adb: ${widgets.length} widget(s) registered`);

function useHash(): string {
  return useSyncExternalStore(
    (cb) => {
      window.addEventListener("hashchange", cb);
      return () => window.removeEventListener("hashchange", cb);
    },
    () => location.hash || "#/",
  );
}

function useTheme() {
  const [dark, setDark] = useState(() =>
    document.documentElement.classList.contains("dark"));
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    try { localStorage.setItem("adb-theme", dark ? "dark" : "light"); } catch { /* private mode */ }
  }, [dark]);
  return { dark, toggle: () => setDark((d) => !d) };
}

export function App() {
  const hash = useHash();
  const { dark, toggle } = useTheme();
  const parts = hash.slice(2).split("/").filter(Boolean);

  let section = "experiments";
  let page: ReactNode;
  let fullHeight = false;
  if (parts[0] === "run" && parts.length === 3) {
    section = "runs";
    fullHeight = true;
    page = <RunPage key={`${parts[1]}/${parts[2]}`} cid={parts[1]!} rid={parts[2]!} />;
  } else if (parts[0] === "experiments" && parts.length === 2) {
    page = <ExperimentPage key={parts[1]} name={decodeURIComponent(parts[1]!)} />;
  } else if (parts[0] === "runs" && parts.length === 2) {
    /* bare run id (lineage links) — resolve to the full #/run/<cid>/<rid> route */
    section = "runs";
    page = <RunResolver key={parts[1]} rid={parts[1]!} />;
  } else if (parts[0] === "runs") {
    section = "runs";
    page = <RunsPage />;
  } else if (import.meta.env.DEV && parts[0] === "dev" && parts[1] === "diagrams") {
    /* prototype gallery — dev builds only, not linked from the sidebar */
    page = <DevDiagramsPage />;
  } else {
    page = <OverviewPage />;
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar section={section} dark={dark} onToggleTheme={toggle} />
      <main
        className={
          fullHeight
            ? "min-w-0 flex-1 overflow-hidden px-5 py-4"
            : "min-w-0 flex-1 overflow-y-auto px-5 py-4 pb-16"
        }
      >
        <div className={fullHeight ? "mx-auto h-full max-w-6xl" : "mx-auto max-w-6xl"}>
          {page}
        </div>
      </main>
    </div>
  );
}
