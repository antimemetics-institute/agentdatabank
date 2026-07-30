/* Guards for the oneliner composer's core invariant: the generated command never
   contains invented placeholder text — an unset param takes a real declared value
   (`initial`, else first suggestion, else first enum member), so the command is
   copyable as-is with a blank form. Only a param the manifest names no value for
   anywhere lands in `missing` (the `<split>` incident's descendant: an unset enum
   now composes as its first member instead of gating the copy button).

   The last test sweeps every real manifest when ADB_WEB_MANIFESTS points at the
   nix-built manifests dir (task web:test wires it); without the env it skips. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildCmd, defaultStr } from "./cmd-build.ts";
import type { ParamDecl } from "../shared/types.ts";

/* no test input contains a literal `<`, so any `<…>` in the output is invented */
const PLACEHOLDER = /<[A-Za-z0-9_]+>/;

const IMPOSSIBLEBENCH: Record<string, ParamDecl> = {
  split: { type: { kind: "enum", values: ["original", "oneoff", "conflicting"] } },
  model: { type: { kind: "llm" } },
  agent_type: { type: { kind: "enum", values: ["minimal", "full"] }, initial: "minimal" },
  max_attempts: { type: { kind: "int" }, initial: 3 },
  limit: { type: { kind: "int" }, initial: 0 },
  generate_args: { type: { kind: "object" }, initial: {} },
  reasoning_tokens: { type: { kind: "int" }, nullable: true },
};

test("unset enum composes as its first member, copyable as-is", () => {
  const { cmd, missing } = buildCmd("impossiblebench-livecodebench", IMPOSSIBLEBENCH, {
    model: "anthropic/claude-haiku-4-5-20251001",
  });
  assert.deepEqual(missing, []);
  assert.match(cmd, /--set split=original/);
  assert.ok(!PLACEHOLDER.test(cmd), `placeholder leaked into:\n${cmd}`);
});

test("unset param with suggestions composes as the first suggestion", () => {
  const params: Record<string, ParamDecl> = {
    model: { type: { kind: "llm" }, suggestions: [
      { value: "mockllm/model", description: "keyless" }, "anthropic/claude-haiku-4-5"] },
    tag: { type: { kind: "str" }, suggestions: ["alpha", "beta"] },
  };
  const { cmd, missing } = buildCmd("x", params, {});
  assert.deepEqual(missing, []);
  assert.match(cmd, /--set model=mockllm\/model/);
  assert.match(cmd, /--set tag=alpha/);
});

test("a param with no declared value anywhere is the only thing that gates", () => {
  const params: Record<string, ParamDecl> = { note: { type: { kind: "str" } } };
  const { cmd, missing } = buildCmd("x", params, {});
  assert.deepEqual(missing, ["note"]);
  assert.ok(!cmd.includes("note"), `unset note must be absent, got:\n${cmd}`);
  assert.ok(!PLACEHOLDER.test(cmd));
});

test("all required params bound -> complete command, nothing missing", () => {
  const { cmd, missing } = buildCmd("impossiblebench-livecodebench", IMPOSSIBLEBENCH, {
    split: "original",
    model: "anthropic/claude-haiku-4-5-20251001",
  });
  assert.deepEqual(missing, []);
  assert.ok(!PLACEHOLDER.test(cmd));
  assert.match(cmd, /--set split=original/);
  assert.match(cmd, /--set model=anthropic\/claude-haiku-4-5-20251001/);
  assert.match(cmd, /--set reasoning_tokens=null/); /* blank nullable = bound null */
  assert.match(cmd, /--set '?generate_args=\{\}'?/); /* initial prefills */
});

test("user value overrides initial; strings quote when not shell-bare", () => {
  const params: Record<string, ParamDecl> = {
    note: { type: { kind: "str" }, initial: "plain" },
  };
  assert.match(buildCmd("x", params, {}).cmd, /--set note=plain/);
  assert.match(buildCmd("x", params, { note: "has spaces" }).cmd, /--set 'note="has spaces"'/);
});

test("no params at all -> bare nix run, nothing missing", () => {
  assert.deepEqual(buildCmd("x", {}, {}), { cmd: "nix run .#x", missing: [] });
});

/* ── shell round trip ────────────────────────────────────────────────────────
   Quoting is only right if a real shell agrees, so these run the generated
   command through /bin/sh — head swapped for a printf that prints each argument
   on its own line — and decode the values the way the runner's parse_value does
   (JSON, else the bare text). What comes back must be what was typed into the
   form, whatever characters it carried. */

function setArgs(cmd: string): Record<string, unknown> {
  const script = cmd.replace(/^nix run \S+(?: --)?/, "printf '%s\\n'");
  const argv = execFileSync("sh", ["-c", script], { encoding: "utf8" }).split("\n").slice(0, -1);
  const out: Record<string, unknown> = {};
  for (let i = 0; i < argv.length; i += 2) {
    assert.equal(argv[i], "--set", `expected --set at argv[${i}], got ${argv[i]}`);
    const entry = argv[i + 1]!;
    const eq = entry.indexOf("=");
    const raw = entry.slice(eq + 1).trim(); /* parse_value strips before parsing */
    let value: unknown;
    try { value = JSON.parse(raw); } catch { value = raw; }
    out[entry.slice(0, eq)] = value;
  }
  return out;
}

test("awkward string values survive the shell verbatim", () => {
  const params: Record<string, ParamDecl> = {
    apostrophe: { type: { kind: "str" } },
    quotes: { type: { kind: "str" } },
    backslash: { type: { kind: "str" } },
    dollars: { type: { kind: "str" } },
    atfile: { type: { kind: "str" } },
    mixed: { type: { kind: "str" } },
  };
  const vals = {
    apostrophe: "it's fine",
    quotes: 'say "hi"',
    backslash: "C:\\tmp\\x",
    dollars: "$HOME and `date`",
    /* bare, this would read as the runner's @file shorthand — a different value
       than the one the form is showing */
    atfile: "@prompt.txt",
    mixed: `'; rm -rf / #`,
  };
  assert.deepEqual(setArgs(buildCmd("x", params, vals).cmd), vals);
});

test("typed values keep their type through the shell", () => {
  const params: Record<string, ParamDecl> = {
    n: { type: { kind: "int" } },
    f: { type: { kind: "float" } },
    b: { type: { kind: "bool" } },
    model: { type: { kind: "llm" } },
    numeric_str: { type: { kind: "str" } },
    items: { type: { kind: "list", of: { kind: "str" } } },
  };
  const got = setArgs(buildCmd("x", params, {
    n: "3", f: "-0.5", b: "true",
    model: "anthropic/claude-haiku-4-5-20251001",
    numeric_str: "42",            /* a string that looks like a number stays a string */
    items: `["it's", "a \\"b\\""]`,
  }).cmd);
  assert.deepEqual(got, {
    n: 3, f: -0.5, b: true,
    model: "anthropic/claude-haiku-4-5-20251001",
    numeric_str: "42",
    items: ["it's", 'a "b"'],
  });
});

test("pretty-printed JSON is compacted, not spliced across lines", () => {
  const params: Record<string, ParamDecl> = {
    agents: { type: { kind: "list", of: { kind: "struct", fields: {} } } },
  };
  const { cmd } = buildCmd("x", params, { agents: '[\n  {\n    "name": "O\'Brien"\n  }\n]' });
  assert.match(cmd, /--set 'agents=\[\{"name":"O'\\''Brien"\}\]'/);
  assert.deepEqual(setArgs(cmd), { agents: [{ name: "O'Brien" }] });
});

test("a half-typed number is quoted rather than spliced in bare", () => {
  const params: Record<string, ParamDecl> = { n: { type: { kind: "int" } } };
  /* the NumberInput commits every keystroke, so mid-edit text reaches the composer */
  assert.equal(buildCmd("x", params, { n: "1e" }).cmd, "nix run .#x -- \\\n  --set 'n=1e'");
});

/* the real manifests: with a blank form, `missing` must be exactly the params
   with no declared value anywhere (no initial/suggestion/enum member) that are
   not nullable — and the command must never carry a placeholder, with the form
   blank or fully filled */
test("every shipped manifest composes placeholder-free", (t) => {
  const dir = process.env.ADB_WEB_MANIFESTS;
  if (!dir) return t.skip("ADB_WEB_MANIFESTS unset (run via `task web:test`)");
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  assert.ok(files.length > 0, `no manifests in ${dir}`);
  for (const f of files) {
    const m = JSON.parse(readFileSync(join(dir, f), "utf8")) as {
      name: string; params?: Record<string, ParamDecl>;
    };
    const params = m.params ?? {};
    const blank = buildCmd(m.name, params, {});
    assert.ok(!PLACEHOLDER.test(blank.cmd), `${m.name}: placeholder in blank-form cmd:\n${blank.cmd}`);
    const required = Object.entries(params)
      .filter(([, d]) => !d.nullable && defaultStr(d) === "")
      .map(([k]) => k)
      .sort();
    assert.deepEqual([...blank.missing].sort(), required, `${m.name}: missing != required`);

    /* fill every param with a plausible value: the command must be complete */
    const vals = Object.fromEntries(
      Object.entries(params).map(([k, d]) => {
        const kind = d.type.kind;
        const v =
          kind === "enum" ? (d.type.values?.[0] ?? "v")
          : kind === "int" || kind === "float" ? "1"
          : kind === "bool" ? "true"
          : kind === "list" ? "[]"
          : kind === "struct" || kind === "object" ? "{}"
          : "value";
        return [k, v];
      }),
    );
    const full = buildCmd(m.name, params, vals);
    assert.deepEqual(full.missing, [], `${m.name}: still missing after fill`);
    assert.ok(!PLACEHOLDER.test(full.cmd), `${m.name}: placeholder in full-form cmd:\n${full.cmd}`);
  }
});
