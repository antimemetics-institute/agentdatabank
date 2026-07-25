/* Bottom-left settings menu: customizes how `nix run` commands render across
   the webui (today: the run-config builder's oneliner). Mirrors the docs gear
   menu — same options, same localStorage key (lib/cmd-prefs.ts), so the choice
   follows the user between guide and webui. */

import { useEffect, useRef, useState } from "react";
import { Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { setCmdPrefs, useCmdPrefs } from "@/lib/cmd-prefs";
import { previewCmd, type CmdPrefs } from "@/lib/cmd-rewrite";
import { cn } from "@/lib/utils";

/* like bits.tsx Segmented, but options carry a label distinct from the stored
   value ("local checkout (.)" vs "local") */
function Seg<K extends string>({ value, options, onChange }: {
  value: K;
  options: readonly { value: K; label: string }[];
  onChange: (v: K) => void;
}) {
  return (
    <span className="inline-flex overflow-hidden rounded-md border text-[11px]">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            "px-2 py-0.5",
            o.value === value
              ? "bg-accent font-medium text-accent-foreground"
              : "text-muted-foreground hover:bg-muted/60",
          )}
        >
          {o.label}
        </button>
      ))}
    </span>
  );
}

function Check({ label, checked, onChange }: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

export function CmdSettings() {
  const [open, setOpen] = useState(false);
  const p = useCmdPrefs();
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  const set = (patch: Partial<CmdPrefs>) => setCmdPrefs(patch);

  return (
    <div ref={wrap} className="relative">
      <Button
        variant="ghost"
        size="sm"
        className="w-full justify-start gap-2.5 px-2.5 text-muted-foreground"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="true"
        aria-expanded={open}
      >
        <Settings />
        settings
      </Button>

      {open && (
        <div
          role="menu"
          className="absolute bottom-full left-0 z-50 mb-2 w-[24rem] space-y-2 rounded-lg border bg-background p-3 shadow-lg"
        >
          <div className="text-xs font-semibold">Commands adapt to your setup</div>
          <code className="block overflow-x-auto rounded border bg-muted/40 p-2 font-mono text-[11px] whitespace-pre">
            {previewCmd(p)}
          </code>

          <div className="flex items-center gap-2">
            <span className="w-9 shrink-0 text-[11px] text-muted-foreground">From</span>
            <Seg
              value={p.source}
              options={[
                { value: "github", label: "GitHub" },
                { value: "local", label: "local checkout (.)" },
              ]}
              onChange={(v) => set({ source: v })}
            />
          </div>

          {/* the mode tabs — the rows below are contextual to the tab */}
          <div className="flex items-center gap-2">
            <span className="w-9 shrink-0 text-[11px] text-muted-foreground">With</span>
            <Seg
              value={p.mode}
              options={[
                { value: "flakes", label: "flakes" },
                { value: "nix-build", label: "nix-build" },
                { value: "nix-run", label: "nix-run" },
              ]}
              onChange={(v) => set({ mode: v })}
            />
          </div>

          {p.mode === "flakes" && (
            /* the registry toggle is meaningless for a local checkout; the
               global-flakes toggle decides whether commands carry the armor flag */
            <div className="flex flex-wrap gap-x-4 gap-y-1 pl-11">
              <Check label="flakes enabled globally" checked={p.flakes}
                onChange={(v) => set({ flakes: v })} />
              {p.source === "github" && (
                <Check label="adb registry added" checked={p.registry}
                  onChange={(v) => set({ registry: v })} />
              )}
            </div>
          )}

          {p.mode === "nix-run" && (
            <div className="pl-11">
              <Check label="nix-run installed globally" checked={p.nixRun}
                onChange={(v) => set({ nixRun: v })} />
            </div>
          )}

          <p className="text-[10px] leading-snug text-muted-foreground">
            Applies to the run-config builder, and is shared with the user guide's
            command settings (same browser storage). See “Working with Nix” in the
            guide for what each toggle means.
          </p>
        </div>
      )}
    </div>
  );
}
