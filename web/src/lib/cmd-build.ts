/* Oneliner composition for the run-config builder — pure and node-testable, no
   React. The invariant this module owns: the generated command NEVER contains
   invented text (`--set 'k=<k>'` placeholders). An unset param is filled with a
   real declared value — its `initial`, else its first suggestion, else an enum's
   first member — so the copy button never gates and a pasted oneliner is always a
   complete, runnable condition spec. Only a param with no declared value anywhere
   (and not nullable) lands in `missing`. The second invariant: whatever the user
   typed is shell-encoded (shQuote), so a value carrying a quote, a space, or a
   newline changes that param's value and nothing else about the command. */

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

/* Drafts contain edits only: undefined is untouched, while an explicit blank
   clears a nullable param. Share this resolution with the form so its displayed
   value agrees with both launch transports. Required blanks still use defaults. */
export const effectiveStr = (decl: ParamDecl, value: string | undefined): string =>
  decl.nullable ? value ?? defaultStr(decl) : value || defaultStr(decl);

/* presentation order: task-level params (low `order`) above harness/generation
   ones; ties break by name. Used by the form and the oneliner alike so they agree. */
export const orderedParams = (params: Record<string, ParamDecl>): [string, ParamDecl][] =>
  Object.entries(params).sort(
    ([ak, a], [bk, b]) => ((a.order ?? 100) - (b.order ?? 100)) || ak.localeCompare(bk));

/* POSIX single-quoting, the encoding `shlex.quote` applies on the runner side: a
   value's own single quotes close the quoting, escape, and reopen (`'\''`). NOTHING
   the user typed is interpolated into the command unquoted except through the
   narrow bare forms below — a param value can never terminate its own token and
   turn the rest of the oneliner into shell syntax. */
export const shQuote = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;

/* the shapes that may appear unquoted: a shell-safe string, a JSON number, a bool.
   Everything else is quoted, including a half-typed number ("1e", "-") — the runner
   rejects it either way, but the command around it stays intact. */
const BARE_STRING = /^[A-Za-z0-9_./:@=+-]+$/;
const NUMBER_LITERAL = /^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
function jsonParses(s: string): boolean {
  try { JSON.parse(s); return true; } catch { return false; }
}

/* a JSON-typed value is re-serialized compact when it parses: pasting a
   pretty-printed blob into a raw textarea would otherwise splice literal newlines
   through the command text. The value is unchanged either way (the runner
   JSON-parses it, so the condition id is identical) — only its spelling is. Text
   that does not parse passes through untouched: the form already flags it, and
   quoting keeps the rest of the command intact meanwhile. */
function compactJson(raw: string): string {
  try { return JSON.stringify(JSON.parse(raw)); } catch { return raw; }
}

/* THE one encoder (the parity rule): every face of "run this condition" — the
   oneliner's shell text and the run button's argv — goes through setParts, so what
   you copy and what the button POSTs are the SAME `key=value` strings, and bind the
   same condition id, by construction rather than by review. setParts decides the
   value's spelling (JSON-typed so the runner, which JSON-parses `--set` values,
   sees the right type) and whether it is shell-safe bare; the faces below only
   differ in transport framing (shell quoting vs raw argv). */
export interface SetPart {
  value: string; /* the exact text after `key=` as the runner will receive it */
  bare: boolean; /* safe to interpolate into shell text unquoted */
}

export function setParts(raw: string, kind: string): SetPart {
  if (kind === "int" || kind === "float")
    return NUMBER_LITERAL.test(raw.trim())
      ? { value: raw.trim(), bare: true }
      : { value: raw, bare: false };
  if (kind === "bool")
    return { value: raw, bare: raw === "true" || raw === "false" };
  if (kind === "list" || kind === "struct" || kind === "object")
    return { value: compactJson(raw), bare: false };
  /* strings go BARE when that round-trips (shell-safe chars, not JSON-parseable —
     the runner's bare-string fallback keeps them strings), so
     `--set model=anthropic/claude-…` reads like the docs; anything else becomes a
     JSON string literal. A leading `@` forces the encoded form: bare, it would read
     as the runner's @file shorthand, so the command would mean something other than
     the literal string the form is showing. */
  if (BARE_STRING.test(raw) && raw[0] !== "@" && !jsonParses(raw))
    return { value: raw, bare: true };
  return { value: JSON.stringify(raw), bare: false };
}

/* shell face: one `--set key=value` for the oneliner text */
export function encodeSet(key: string, raw: string, kind: string): string {
  const { value, bare } = setParts(raw, kind);
  return bare ? `--set ${key}=${value}` : `--set ${shQuote(`${key}=${value}`)}`;
}

/* argv face: the raw `key=value` string handed to the runner as ONE argv entry
   (spawn, no shell) — exactly what the shell face's quoting unwraps to */
export function setArg(key: string, raw: string, kind: string): string {
  return `${key}=${setParts(raw, kind).value}`;
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

/* ONE materialization loop for every face: an unset param takes its declared
   default (defaultStr); an empty nullable param is bound to null; only a param
   with no declared value at all goes to `missing`. Faces map each bound param
   through their encoder — they can't disagree about WHICH params are bound. */
function materialize(
  params: Record<string, ParamDecl>,
  vals: Record<string, string>,
  encode: (key: string, raw: string, kind: string) => string,
  nullForm: (key: string) => string,
): { args: string[]; missing: string[] } {
  const args: string[] = [];
  const missing: string[] = [];
  for (const [k, decl] of orderedParams(params)) {
    const cur = effectiveStr(decl, vals[k]);
    if (cur === "") {
      if (decl.nullable) args.push(nullForm(k));
      else missing.push(k);
    } else {
      args.push(encode(k, cur, decl.type.kind));
    }
  }
  return { args, missing };
}

/* every bound param is emitted explicitly — the oneliner is the complete condition
   spec, defaults materialized into the command text rather than hidden behind it. */
export function buildCmd(
  name: string,
  params: Record<string, ParamDecl>,
  vals: Record<string, string>,
  dataDir?: string,
): BuiltCmd {
  const { args, missing } = materialize(params, vals, encodeSet, (k) => `--set ${k}=null`);
  if (dataDir !== undefined) args.unshift(`--data-dir ${shQuote(dataDir)}`);
  const cmd = args.length
    ? `nix run .#${name} -- \\\n  ${args.join(" \\\n  ")}`
    : `nix run .#${name}`;
  return { cmd, missing };
}

/* the run button's POST body: the same materialization, argv framing — each entry
   is one `key=value` string for a `--set` argv pair, secrets nowhere in sight */
export function buildArgs(
  params: Record<string, ParamDecl>,
  vals: Record<string, string>,
): { sets: string[]; missing: string[] } {
  const { args, missing } = materialize(params, vals, setArg, (k) => `${k}=null`);
  return { sets: args, missing };
}
