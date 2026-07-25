/* Run-config builder: a manifest-driven param form that generates the `nix run`
   oneliner. Read-only convenience — it never runs anything; it produces the exact
   copy-paste invocation. EVERY param becomes a `--set`: experiments have no
   defaults (a manifest's `initial` only prefills this form), so the oneliner is
   the complete condition spec — nothing hidden at the experiment level, and an
   author changing an `initial` can never change what a pasted oneliner means.
   Degrades to a note when the server has no manifests dir (bare dev.sh). */

import { Fragment, useMemo, useState } from "react";
import { buildCmd, defaultStr, initialStr, orderedParams } from "@/lib/cmd-build";
import { useCmdPrefs } from "@/lib/cmd-prefs";
import { rewriteCmd } from "@/lib/cmd-rewrite";
import { useManifests } from "@/lib/data";
import { Card } from "@/components/ui/card";
import type { ParamDecl, ParamType, StructField, Suggestion } from "@/shared/types";

const INPUT =
  "min-w-0 flex-1 rounded border bg-background px-2 py-1 font-mono text-xs " +
  "outline-none focus:ring-2 focus:ring-ring";
const BTN =
  "rounded border px-2 py-1 text-xs hover:bg-muted disabled:opacity-40";

/* free-text combobox for a suggestions field: focus/click shows ALL options; typing
   narrows to matches; click away and back shows all again (until you type). Any value
   is allowed — it's a suggestion list, not an enum. Entries may carry a one-line
   description (e.g. a task's docstring summary), shown under the value. */
function Combobox({ value, onChange, suggestions }: {
  value: string; onChange: (v: string) => void; suggestions: Suggestion[];
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const entries = suggestions.map((s) => (typeof s === "string" ? { value: s } : s));
  const q = value.toLowerCase();
  const list = editing
    ? entries.filter((s) =>
        s.value.toLowerCase().includes(q) || s.description?.toLowerCase().includes(q))
    : entries;
  const showAll = () => { setEditing(false); setOpen(true); };
  return (
    <div className="relative min-w-0 flex-1">
      <input type="text" className={`${INPUT} w-full`} value={value} spellCheck={false}
        onFocus={showAll} onClick={showAll}
        onBlur={() => setOpen(false)}
        onChange={(e) => { setEditing(true); setOpen(true); onChange(e.target.value); }}
        onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }} />
      {open && list.length > 0 && (
        <ul className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded border bg-background py-1 text-xs shadow-md">
          {list.map((s) => (
            <li key={s.value}
              onMouseDown={(e) => { e.preventDefault(); onChange(s.value); setEditing(false); setOpen(false); }}
              className="cursor-pointer px-2 py-0.5 hover:bg-muted">
              <span className="block truncate font-mono">{s.value}</span>
              {s.description && (
                <span className="block truncate text-[10px] text-muted-foreground">
                  {s.description}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* the type annotation chip next to a field label — every param shows its kind
   (list element types spelled out, nullable stated), not just the special ones */
function TypeBadge({ decl }: { decl: ParamDecl }) {
  const t = decl.type;
  const label =
    (t.kind === "list" ? `list(${t.of?.kind ?? "?"})` : t.kind) +
    (decl.nullable ? " | null" : "");
  return (
    <span className="rounded bg-muted px-1 text-[10px] font-normal text-muted-foreground">
      {label}
    </span>
  );
}

/* a field's "empty" value, used for fresh rows and cleared cells */
const zeroOf = (t: ParamType): unknown =>
  t.kind === "int" || t.kind === "float" ? 0
  : t.kind === "bool" ? false
  : t.kind === "enum" ? (t.values?.[0] ?? "")
  : "";

/* a struct field is a bare type or a param-wrapped one carrying hints (suggestions,
   description) — normalize to a ParamDecl so cells render exactly like top-level
   params (a wrapped llm field gets the same search dropdown) */
const fieldDecl = (f: StructField): ParamDecl =>
  "kind" in f ? { type: f } : (f as ParamDecl);

const cellStr = (v: unknown): string =>
  v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);

/* shared header for the list editors: entry count + the raw-JSON toggle */
function ListHead({ label, raw, setRaw }: {
  label: string; raw: boolean; setRaw: (f: (r: boolean) => boolean) => void;
}) {
  return (
    <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
      <span>{label}</span>
      <button type="button"
        className={`ml-auto rounded border px-1.5 py-0.5 ${raw ? "bg-muted text-foreground" : "hover:text-foreground"}`}
        title="edit the whole value as one JSON array"
        onClick={() => setRaw((r) => !r)}>
        raw
      </button>
    </div>
  );
}

/* row editor for a listOf(struct) param — the "cast/roster" shape (concordia's
   agents, werewolf's players): one row per entry, one typed cell per struct field,
   add/remove rows. The value stays a JSON string (oneliner encoder and wire
   unchanged); rows are serialized in schema field order so an untouched form
   round-trips byte-equal to the default. */
export function StructListEditor({ decl, value, onChange }: {
  decl: ParamDecl; value: string; onChange: (v: string) => void;
}) {
  const fields = Object.entries(decl.type.of?.fields ?? {})
    .map(([f, t]) => [f, fieldDecl(t)] as [string, ParamDecl]);
  const [raw, setRaw] = useState(false);
  /* three value shapes: plain rows (the editor), valid JSON that isn't rows (a ~dist
     spec like werewolf's ~zip/~perm players — legal, but only raw-editable), or
     broken JSON mid-edit */
  let rows: Record<string, unknown>[] | null = null;
  let broken = false;
  try {
    const parsed: unknown = JSON.parse(value || "[]");
    if (Array.isArray(parsed) && parsed.every((r) => r && typeof r === "object" && !Array.isArray(r)))
      rows = parsed as Record<string, unknown>[];
  } catch { broken = true; }
  const minLen = typeof decl.minLen === "number" ? decl.minLen : 0;
  const serialize = (rs: Record<string, unknown>[]) =>
    JSON.stringify(rs.map((r) => {
      const o: Record<string, unknown> = {};
      for (const [f, t] of fields) o[f] = r[f] ?? zeroOf(t.type);
      return o;
    }));
  const setCell = (i: number, f: string, t: ParamDecl, rawVal: string) => {
    const next = rows!.map((r) => ({ ...r }));
    let v = rawVal === "" ? zeroOf(t.type) : coerce(rawVal, t.type.kind);
    if (typeof v === "number" && Number.isNaN(v)) v = zeroOf(t.type);
    next[i]![f] = v;
    onChange(serialize(next));
  };
  if (raw || rows === null)
    return (
      <div className="min-w-0 flex-1 space-y-1.5 rounded border border-dashed p-2">
        <ListHead
          label={broken ? "unparseable — fix the JSON"
            : rows === null ? "not a plain list (a ~dist spec) — raw JSON only"
            : `${rows.length} entries`}
          raw={true} setRaw={setRaw} />
        <textarea className={`${INPUT} h-24 w-full resize-y`} spellCheck={false}
          value={value} onChange={(e) => onChange(e.target.value)} />
      </div>
    );
  return (
    <div className="min-w-0 flex-1 space-y-1.5 rounded border border-dashed p-2">
      <ListHead label={`${rows.length} entries`} raw={raw} setRaw={setRaw} />
      <div className="grid items-center gap-1.5"
        style={{ gridTemplateColumns: `repeat(${fields.length}, minmax(0, 1fr)) 1.25rem` }}>
        {fields.map(([f, t]) => (
          <span key={f} title={t.description}
            className="flex items-baseline gap-1 font-mono text-[11px] text-muted-foreground">
            {f}
            {["llm", "run", "harness", "enum"].includes(t.type.kind) && (
              <span className="rounded bg-muted px-1 text-[9px]">{t.type.kind}</span>
            )}
          </span>
        ))}
        <span />
        {rows.map((r, i) => (
          <Fragment key={i}>
            {fields.map(([f, t]) => (
              <Widget key={f} decl={t} value={cellStr(r[f] ?? zeroOf(t.type))}
                onChange={(v) => setCell(i, f, t, v)} />
            ))}
            <button type="button"
              className="justify-self-center text-muted-foreground hover:text-foreground disabled:opacity-30"
              title={rows!.length <= minLen ? `min ${minLen} entries` : "remove this entry"}
              disabled={rows.length <= minLen}
              onClick={() => onChange(serialize(rows!.filter((_, j) => j !== i)))}>
              ✕
            </button>
          </Fragment>
        ))}
      </div>
      <button type="button" className={BTN}
        onClick={() => onChange(serialize([...rows!, Object.fromEntries(fields.map(([f, t]) => [f, zeroOf(t.type)]))]))}>
        + add
      </button>
    </div>
  );
}

/* list editor for a listOf(scalar) param (e.g. a list of strings): one input per
   item, add/remove. Same JSON-string value contract as the struct editor. */
export function ScalarListEditor({ decl, value, onChange }: {
  decl: ParamDecl; value: string; onChange: (v: string) => void;
}) {
  const of = decl.type.of!;
  const [raw, setRaw] = useState(false);
  let items: unknown[] | null = null;
  let broken = false;
  try {
    const parsed: unknown = JSON.parse(value || "[]");
    if (Array.isArray(parsed)) items = parsed;
  } catch { broken = true; }
  const minLen = typeof decl.minLen === "number" ? decl.minLen : 0;
  if (raw || items === null)
    return (
      <div className="min-w-0 flex-1 space-y-1.5 rounded border border-dashed p-2">
        <ListHead
          label={broken ? "unparseable — fix the JSON"
            : items === null ? "not a plain list (a ~dist spec) — raw JSON only"
            : `${items.length} entries`}
          raw={true} setRaw={setRaw} />
        <textarea className={`${INPUT} h-16 w-full resize-y`} spellCheck={false}
          value={value} onChange={(e) => onChange(e.target.value)} />
      </div>
    );
  const setItem = (i: number, rawVal: string) => {
    const next = [...items!];
    let v = rawVal === "" ? zeroOf(of) : coerce(rawVal, of.kind);
    if (typeof v === "number" && Number.isNaN(v)) v = zeroOf(of);
    next[i] = v;
    onChange(JSON.stringify(next));
  };
  return (
    <div className="min-w-0 flex-1 space-y-1.5 rounded border border-dashed p-2">
      <ListHead label={`${items.length} entries`} raw={raw} setRaw={setRaw} />
      {items.map((it, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <Widget decl={{ type: of }} value={cellStr(it)} onChange={(v) => setItem(i, v)} />
          <button type="button"
            className="text-muted-foreground hover:text-foreground disabled:opacity-30"
            title={items!.length <= minLen ? `min ${minLen} entries` : "remove this entry"}
            disabled={items.length <= minLen}
            onClick={() => onChange(JSON.stringify(items!.filter((_, j) => j !== i)))}>
            ✕
          </button>
        </div>
      ))}
      <button type="button" className={BTN}
        onClick={() => onChange(JSON.stringify([...items!, zeroOf(of)]))}>
        + add
      </button>
    </div>
  );
}

function Widget({ decl, value, onChange, optional }: {
  decl: ParamDecl; value: string; onChange: (v: string) => void;
  /* selects get an explicit empty state so what the form shows is exactly what is
     passed — a bare select would silently display its first option while the value
     is empty. "unset" = sub-form field omitted from the object; "null" = top-level
     nullable param bound to null. */
  optional?: "unset" | "null";
}) {
  const kind = decl.type.kind;
  const emptyLabel = optional === "null" ? "(null)" : "(unset)";
  if (kind === "bool")
    return (
      <select className={INPUT} value={optional ? value : value || "false"}
        onChange={(e) => onChange(e.target.value)}>
        {optional && <option value="">{emptyLabel}</option>}
        <option value="false">false</option>
        <option value="true">true</option>
      </select>
    );
  if (kind === "enum")
    return (
      <select className={INPUT} value={value} onChange={(e) => onChange(e.target.value)}>
        {optional && <option value="">{emptyLabel}</option>}
        {(decl.type.values ?? []).map((v) => <option key={v} value={v}>{v}</option>)}
      </select>
    );
  if (kind === "int" || kind === "float")
    return (
      <input type="number" className={INPUT} value={value}
        step={kind === "float" ? "any" : "1"}
        onChange={(e) => onChange(e.target.value)} />
    );
  if (kind === "list") {
    /* typed editors from the manifest's element schema — a list is only ever a raw
       JSON textarea when its element type gives us nothing to build a form from */
    const of = decl.type.of;
    if (of?.kind === "struct" && of.fields)
      return <StructListEditor decl={decl} value={value} onChange={onChange} />;
    if (of && ["str", "llm", "run", "harness", "int", "float", "bool", "enum"].includes(of.kind))
      return <ScalarListEditor decl={decl} value={value} onChange={onChange} />;
  }
  if (kind === "list" || kind === "struct" || kind === "object")
    return (
      <textarea className={`${INPUT} h-16 resize-y`} value={value} spellCheck={false}
        onChange={(e) => onChange(e.target.value)} />
    );
  /* str, llm, run, harness — a text field. With suggestions, a combobox (focus/click
     shows ALL, typing narrows); free text always allowed. */
  if (decl.suggestions?.length)
    return <Combobox value={value} onChange={onChange} suggestions={decl.suggestions} />;
  return (
    <input type="text" className={INPUT} value={value} spellCheck={false}
      onChange={(e) => onChange(e.target.value)} />
  );
}

/* widget string → typed json value, for assembling a variant object */
function coerce(raw: string, kind: string): unknown {
  if (kind === "int") return parseInt(raw, 10);
  if (kind === "float") return parseFloat(raw);
  if (kind === "bool") return raw === "true";
  if (kind === "object" || kind === "list" || kind === "struct") {
    try { return JSON.parse(raw); } catch { return raw; }
  }
  return raw; /* str, enum, llm, run, harness */
}

/* the typed sub-form for a variant object (e.g. inspect's task_args for the selected
   task): render each field with the normal widget, assemble only changed-from-default
   fields into the object value (kept as a json string — so the oneliner encoder and the
   wire are unchanged). A big schema (inspect's generate_args is ~37 knobs) starts
   folded to just the fields that are set; a "raw" toggle swaps the whole sub-form for
   the JSON blob, for pasting a config or setting a knob the schema doesn't surface. */
const BIG_SUBFORM = 8;

function VariantObject({ schema, value, onChange }: {
  schema: Record<string, ParamDecl>; value: string; onChange: (v: string) => void;
}) {
  let obj: Record<string, unknown> = {};
  try { obj = value ? JSON.parse(value) : {}; } catch { obj = {}; }
  const fields = Object.entries(schema);
  const setKeys = fields.filter(([f]) => f in obj).map(([f]) => f);
  const big = fields.length > BIG_SUBFORM;
  const [expanded, setExpanded] = useState(!big);
  const [raw, setRaw] = useState(false);
  const fieldStr = (f: string, decl: ParamDecl): string =>
    f in obj ? (typeof obj[f] === "object" ? JSON.stringify(obj[f]) : String(obj[f])) : initialStr(decl);
  const setField = (f: string, decl: ParamDecl, rawVal: string) => {
    const next = { ...obj };
    if (rawVal === "" || rawVal === initialStr(decl)) delete next[f];
    else next[f] = coerce(rawVal, decl.type.kind);
    onChange(JSON.stringify(next)); /* "{}" == default → omitted from the oneliner */
  };
  const visible = expanded ? fields : fields.filter(([f]) => f in obj);
  return (
    <div className="min-w-0 flex-1 space-y-2 rounded border border-dashed p-2">
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        {fields.length === 0 ? (
          <span>no args</span>
        ) : (
          big && (
            <button type="button" className="hover:text-foreground"
              onClick={() => setExpanded((e) => !e)}>
              {expanded ? "▾" : "▸"} {fields.length} fields
              {setKeys.length > 0 && ` (${setKeys.length} set)`}
            </button>
          )
        )}
        <button type="button"
          className={`ml-auto rounded border px-1.5 py-0.5 ${raw ? "bg-muted text-foreground" : "hover:text-foreground"}`}
          title="edit the whole value as one JSON object"
          onClick={() => setRaw((r) => !r)}>
          raw
        </button>
      </div>
      {raw ? (
        <textarea className={`${INPUT} h-24 w-full resize-y`} spellCheck={false}
          value={value || "{}"} onChange={(e) => onChange(e.target.value)} />
      ) : (
        visible.map(([f, decl]) => (
          <div key={f} className="space-y-0.5">
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex min-w-28 items-baseline gap-1 font-mono text-[11px] text-muted-foreground"
                title={decl.description ?? decl.type.kind}>
                {f}
                <TypeBadge decl={decl} />
              </label>
              <Widget decl={decl} value={fieldStr(f, decl)} onChange={(v) => setField(f, decl, v)}
                optional={initialStr(decl) === "" ? "unset" : undefined} />
            </div>
            {decl.description && (
              <p className="pl-28 text-[10px] leading-tight text-muted-foreground/70">{decl.description}</p>
            )}
          </div>
        ))
      )}
    </div>
  );
}

function CopyIcon({ copied }: { copied: boolean }) {
  return copied ? (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  ) : (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

export function Builder({ name }: { name: string }) {
  const manifests = useManifests();
  const [vals, setVals] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState(false);
  /* open by default: the overview's zero-run cards point here to compose a first
     command, so the form is the page's primary content */
  const [open, setOpen] = useState(true);

  const manifest = manifests?.find((m) => m.name === name);
  const params = manifest?.params ?? {};

  /* what the form shows = what the command carries: the user's value, else the
     param's declared default (initial / first suggestion / first enum member) —
     so a fresh form is already a complete, runnable condition. Nullable params
     stay blank instead: empty means bound-to-null, not defaulted. */
  const eff = (k: string): string => {
    const decl = params[k]!;
    const v = vals[k] ?? "";
    if (v !== "") return v;
    return decl.nullable ? "" : defaultStr(decl);
  };
  const set = (k: string, v: string) => {
    setVals((s) => {
      const next: Record<string, string> = { ...s, [k]: v };
      // a variant object's fields depend on this param — clear it so it re-derives
      for (const [pk, pd] of Object.entries(params)) if (pd.depends_on === k) delete next[pk];
      return next;
    });
    setCopied(false);
  };

  /* composed canonically (`nix run .#…`) by buildCmd — which never invents
     placeholder text; a blank required param comes back in `missing` instead —
     then rendered to the user's Nix setup via the bottom-left settings menu
     (the same rewrite the docs apply). While params are missing the command is
     shown but copy is gated: the incomplete state lives in the UI, never in
     the copied text. */
  const prefs = useCmdPrefs();
  const { oneliner, missing } = useMemo(() => {
    const { cmd, missing } = buildCmd(name, params, vals);
    return { oneliner: rewriteCmd(cmd, prefs), missing };
  }, [name, params, vals, prefs]);

  const copy = () => {
    if (missing.length > 0) return;
    void navigator.clipboard?.writeText(oneliner).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  if (manifests === null) return null; /* still loading */
  if (!manifest)
    return (
      <p className="text-xs text-muted-foreground">
        run-config builder unavailable (no manifest for <b>{name}</b> — the server needs
        its <code>ADB_WEB_MANIFESTS</code> dir, set by the nix <code>adb-web</code> wrapper).
      </p>
    );

  const dirty = Object.keys(vals).length > 0;

  return (
    <Card className="p-0">
      <button type="button" onClick={() => setOpen((o) => !o)}
        className="flex w-full items-baseline justify-between gap-2 p-4 text-left hover:bg-muted/40">
        <h3 className="text-sm font-semibold">
          <span className="mr-1.5 inline-block w-2 text-muted-foreground">{open ? "▾" : "▸"}</span>
          configure a run
        </h3>
        {manifest.summary && (
          <span className="truncate text-xs text-muted-foreground">{manifest.summary}</span>
        )}
      </button>

      {open && (
        <div className="space-y-3 px-4 pb-4">
          {dirty && (
            <div className="flex flex-wrap items-center gap-1.5">
              <button type="button" className={BTN} onClick={() => { setVals({}); setCopied(false); }}>
                reset
              </button>
            </div>
          )}

          {/* space-y-4 between params vs space-y-0.5 inside one: a description must
              sit visibly closer to its own field (above it) than to the next field,
              or it reads as ambiguous */}
          <div className="space-y-4">
            {orderedParams(params).map(([k, decl], i, entries) => {
              // typed sub-form: a fixed field schema (decl.fields, e.g. generate_args
              // from inspect's GenerateConfig) or a variant that depends on another
              // param's value (decl.variants[that value], e.g. task_args per task).
              const subform = decl.fields ?? (decl.depends_on ? decl.variants?.[eff(decl.depends_on)] : undefined);
              // a small section label where the param group changes (task / model / …)
              const heading = decl.group && decl.group !== entries[i - 1]?.[1].group ? decl.group : undefined;
              // data-param: stable hook for e2e drivers and the docs GIF recorder
              return (
                <div key={k} data-param={k} className="space-y-0.5">
                  {heading && (
                    <div className="pt-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60">
                      {heading}
                    </div>
                  )}
                  <div className="flex flex-wrap items-start gap-2">
                    <label className="flex min-w-40 items-baseline gap-1.5 py-1 font-mono text-xs">
                      {k}
                      <TypeBadge decl={decl} />
                    </label>
                    {subform ? (
                      /* keyed by the variant selector so switching (e.g.) task remounts
                         the sub-form with fresh folded/raw state */
                      <VariantObject key={decl.depends_on ? eff(decl.depends_on) : k}
                        schema={subform} value={eff(k)} onChange={(v) => set(k, v)} />
                    ) : (
                      /* the form shows the declared default (eff), and buildCmd
                         emits the same value — so a bare select showing its first
                         member IS the truth now. "(unset)" survives only for a
                         param with no declared value anywhere */
                      <Widget decl={decl} value={eff(k)} onChange={(v) => set(k, v)}
                        optional={decl.nullable ? "null" : defaultStr(decl) === "" ? "unset" : undefined} />
                    )}
                  </div>
                  {decl.description && (
                    <p className="pl-40 text-[10px] leading-tight text-muted-foreground/70">{decl.description}</p>
                  )}
                </div>
              );
            })}
          </div>

          <div className="space-y-1">
            <span className="text-xs text-muted-foreground">
              oneliner{copied && <span className="ml-1 text-emerald-600 dark:text-emerald-400">copied ✓</span>}
              {missing.length > 0 && (
                <span className="ml-1 text-amber-600 dark:text-amber-400">
                  — set {missing.map((k) => <code key={k} className="mx-0.5">{k}</code>)} to copy
                </span>
              )}
            </span>
            <div className={`group relative ${missing.length ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}
              onClick={copy} title={missing.length ? `missing: ${missing.join(", ")}` : "click to copy"}
              role="button" tabIndex={0} aria-disabled={missing.length > 0}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") copy(); }}>
              <pre className={`overflow-x-auto rounded border bg-muted/40 p-2 pr-9 font-mono text-xs
                ${missing.length ? "" : "group-hover:border-ring"}`}>{oneliner}</pre>
              {missing.length === 0 && (
                <span className="absolute right-2 top-2 text-muted-foreground group-hover:text-foreground">
                  <CopyIcon copied={copied} />
                </span>
              )}
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
