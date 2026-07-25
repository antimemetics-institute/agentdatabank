/* Oneliner composition for the run-config builder — pure and node-testable, no
   React. The invariant this module owns: the generated command NEVER contains
   invented text (`--set 'k=<k>'` placeholders). An unset param is filled with a
   real declared value — its `initial`, else its first suggestion, else an enum's
   first member — so the copy button never gates and a pasted oneliner is always a
   complete, runnable condition spec. Only a param with no declared value anywhere
   (and not nullable) lands in `missing`. */

import type { ParamDecl } from "@/shared/types";

export const initialStr = (decl: ParamDecl): string => {
  const d = decl.initial;
  if (d === undefined || d === null) return "";
  return typeof d === "object" ? JSON.stringify(d) : String(d);
};

/* a real declared value for an unset param: `initial`, else the first suggestion,
   else an enum's first member. "" = the manifest names no value at all. */
export const defaultStr = (decl: ParamDecl): string => {
  const init = initialStr(decl);
  if (init !== "") return init;
  const s = decl.suggestions?.[0];
  if (s !== undefined) {
    const v = typeof s === "string" ? s : s.value;
    if (v !== "") return v;
  }
  return decl.type.values?.[0] ?? "";
};

/* presentation order: task-level params (low `order`) above harness/generation
   ones; ties break by name. Used by the form and the oneliner alike so they agree. */
export const orderedParams = (params: Record<string, ParamDecl>): [string, ParamDecl][] =>
  Object.entries(params).sort(
    ([ak, a], [bk, b]) => ((a.order ?? 100) - (b.order ?? 100)) || ak.localeCompare(bk));

/* one `--set key=value`, JSON- and shell-encoded so the runner (which JSON-parses
   `--set` values) sees the right type. Numbers/bools go bare; list/struct values are
   raw JSON the user typed (single-quoted for the shell). Strings go BARE when that
   round-trips (shell-safe chars, not JSON-parseable — the runner's bare-string
   fallback keeps them strings), so `--set model=anthropic/claude-…` reads like the
   docs; anything else becomes a quoted JSON string literal. */
const BARE_STRING = /^[A-Za-z0-9_./:@=+-]+$/;
function jsonParses(s: string): boolean {
  try { JSON.parse(s); return true; } catch { return false; }
}
export function encodeSet(key: string, raw: string, kind: string): string {
  if (kind === "int" || kind === "float" || kind === "bool") return `--set ${key}=${raw}`;
  if (kind === "list" || kind === "struct" || kind === "object") return `--set '${key}=${raw}'`;
  if (BARE_STRING.test(raw) && !jsonParses(raw)) return `--set ${key}=${raw}`;
  return `--set '${key}=${JSON.stringify(raw)}'`;
}

export interface BuiltCmd {
  /* canonical `nix run .#…` oneliner (one `--set` per backslash-continued line,
     same style as the docs — the portable spelling: bash, zsh, and fish all take
     `\`). Contains only params that have a value; complete iff `missing` is empty. */
  cmd: string;
  /* params the manifest declares NO value for anywhere — no `initial`, no
     suggestions, no enum members — and not nullable. Rare; the UI surfaces these
     and gates copy on them. */
  missing: string[];
}

/* every bound param is emitted explicitly — the oneliner is the complete condition
   spec, defaults materialized into the command text rather than hidden behind it.
   An unset param takes its declared default (defaultStr); an empty nullable param
   is bound to null; only a param with no declared value at all goes to `missing`. */
export function buildCmd(
  name: string,
  params: Record<string, ParamDecl>,
  vals: Record<string, string>,
): BuiltCmd {
  const args: string[] = [];
  const missing: string[] = [];
  for (const [k, decl] of orderedParams(params)) {
    const cur = vals[k] || defaultStr(decl);
    if (cur === "") {
      if (decl.nullable) args.push(`--set ${k}=null`);
      else missing.push(k);
    } else {
      args.push(encodeSet(k, cur, decl.type.kind));
    }
  }
  const cmd = args.length
    ? `nix run .#${name} -- \\\n  ${args.join(" \\\n  ")}`
    : `nix run .#${name}`;
  return { cmd, missing };
}
