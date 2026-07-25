/* Persistent left navigation: brand, section links with active state, and at the
   bottom a deliberately subtle webui↔server CONNECTIVITY indicator (run liveness
   lives next to the streams it vouches for — components/bits.tsx LiveDot), the
   command-settings menu, and the theme toggle. Sections map onto the hash routes;
   the run page highlights Runs, experiment pages highlight Experiments. */

import { FlaskConical, List, Moon, Sun } from "lucide-react";
import { usePollHealth } from "@/lib/data";
import { Button } from "@/components/ui/button";
import { CmdSettings } from "@/components/cmd-settings";
import { cn } from "@/lib/utils";

const NAV = [
  { section: "experiments", href: "#/", label: "Experiments", Icon: FlaskConical },
  { section: "runs", href: "#/runs", label: "Runs", Icon: List },
] as const;

export function Sidebar({
  section,
  dark,
  onToggleTheme,
}: {
  section: string;
  dark: boolean;
  onToggleTheme: () => void;
}) {
  return (
    <aside className="flex w-44 shrink-0 flex-col border-r bg-card/50">
      <a href="#/" className="px-4 py-3.5 font-mono text-lg font-bold tracking-widest no-underline">
        adb
      </a>
      <nav className="flex-1 space-y-0.5 px-2">
        {NAV.map(({ section: s, href, label, Icon }) => (
          <a
            key={s}
            href={href}
            className={cn(
              "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground no-underline transition-colors hover:bg-accent hover:text-accent-foreground",
              s === section && "bg-accent font-medium text-accent-foreground",
            )}
          >
            <Icon className="size-4" />
            {label}
          </a>
        ))}
      </nav>
      <div className="space-y-1 border-t p-2">
        <ConnectedDot />
        <CmdSettings />
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start gap-2.5 px-2.5 text-muted-foreground"
          onClick={onToggleTheme}
          aria-label="toggle theme"
        >
          {dark ? <Sun /> : <Moon />}
          {dark ? "light mode" : "dark mode"}
        </Button>
      </div>
    </aside>
  );
}

function ConnectedDot() {
  const { live } = usePollHealth();
  return (
    <div
      className="flex items-center gap-2 px-2.5 py-0.5 text-[11px] text-muted-foreground/80"
      title="webui ↔ adb-web server connectivity (background polls, every 2s). Not run liveness — that dot sits next to each live stream."
    >
      <span className={cn("size-1.5 rounded-full", live ? "bg-emerald-500" : "bg-amber-500")} />
      {live ? "connected" : "offline"}
    </div>
  );
}
