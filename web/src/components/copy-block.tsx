import { useState } from "react";
import { Check, Copy } from "lucide-react";

/** A selectable multiline snippet with a copy button. */
export function CopyBlock({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  return <div className="min-w-0 overflow-hidden rounded-md border">
    <div className="flex flex-wrap items-center justify-between gap-3 border-b px-3 py-2 text-xs">
      <span className="font-medium">{label}</span>
      <button type="button" aria-label={`Copy ${label}`}
        className="inline-flex items-center gap-1.5 rounded px-1 text-muted-foreground hover:bg-accent"
        onClick={async () => {
          try { await navigator.clipboard.writeText(text); setCopied(true); setError(false); }
          catch { setCopied(false); setError(true); }
        }}>
        {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
        <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
      </button>
    </div>
    <pre className="overflow-x-auto bg-muted/30 p-3 font-mono text-xs leading-relaxed"><code>{text}</code></pre>
    {error && <p role="status" className="px-3 pb-2 text-xs text-destructive">Copy unavailable; select the text to copy it.</p>}
  </div>;
}
