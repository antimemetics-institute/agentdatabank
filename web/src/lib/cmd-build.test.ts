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
