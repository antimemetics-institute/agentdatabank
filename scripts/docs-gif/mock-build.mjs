#!/usr/bin/env node
/* Recording-only ADB_WORKER_BUILD hook. Keep the real Nix build and runner,
   wrapping just the experiment entrypoint to configure Inspect's mock output.
   PYTHONPATH is set AFTER the runner's normal child-environment filtering. */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
if (args.at(-1) !== "exec.inspect-hello") throw new Error("docs fixture supports inspect-hello only");
const built = execFileSync("nix-build", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
const source = readFileSync(built, "utf8");
const adapter = source.match(/^export ADB_EXPERIMENT_BIN=(\S+)$/m)?.[1];
if (!adapter) throw new Error("unexpected experiment executable format");
const dir = process.env.ADB_DOCS_FIXTURE_DIR;
if (!dir) throw new Error("missing isolated docs fixture directory");
mkdirSync(dir, { recursive: true });
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixture");
const wrappedAdapter = join(dir, "adapter");
writeFileSync(wrappedAdapter, `${source.split("\n")[0]}\nexport PYTHONPATH=${quote(fixture)}\nexport PYTHONDONTWRITEBYTECODE=1\nexec ${quote(adapter)} "$@"\n`, { mode: 0o700 });
const wrappedExec = join(dir, "exec");
writeFileSync(wrappedExec, source
  .replace(/^export ADB_EXPERIMENT_BIN=.*$/m, `export ADB_EXPERIMENT_BIN=${quote(wrappedAdapter)}`)
  .replace(/^export ADB_SOURCE=.*$/m, "export ADB_SOURCE=dirty:docs-recording-fixture")
  .replace(/^export ADB_FETCH_REF=.*$/m, "export ADB_FETCH_REF=dirty:docs-recording-fixture"), { mode: 0o700 });
console.log(wrappedExec);
