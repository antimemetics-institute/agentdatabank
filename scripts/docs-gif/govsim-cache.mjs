#!/usr/bin/env node
/* Wrap an already built exec.govsim; configuration is embedded in the child
   wrapper because the runner deliberately filters its inherited environment. */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const options = {};
while (args.length && args[0] !== "--") {
  const key = args.shift();
  if (!["--mode", "--cache", "--work-dir", "--exec", "--miss-file"].includes(key) || !args.length)
    throw new Error("Usage: govsim-cache.mjs --mode record|replay --cache FILE --work-dir DIR --exec BUILT_EXEC -- RUNNER_ARGS");
  options[key.slice(2)] = args.shift();
}
if (args.shift() !== "--" || !["record", "replay"].includes(options.mode) || !options.cache || !options["work-dir"] || !options.exec)
  throw new Error("Supply --mode, --cache, --work-dir, --exec, and -- before normal runner arguments");
const source = readFileSync(resolve(options.exec), "utf8");
const adapter = source.match(/^export ADB_EXPERIMENT_BIN=(\S+)$/m)?.[1];
if (!adapter || !adapter.includes("govsim")) throw new Error("Expected a built exec.govsim shell entrypoint");
const directory = resolve(options["work-dir"]);
mkdirSync(directory, { recursive: true, mode: 0o700 });
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const fixture = join(dirname(fileURLToPath(import.meta.url)), "govsim-cache");
const wrappedAdapter = join(directory, "adapter");
writeFileSync(wrappedAdapter, `${source.split("\n")[0]}
export PYTHONPATH=${quote(fixture)}
export PYTHONDONTWRITEBYTECODE=1
export ADB_DOCS_CACHE_MODE=${quote(options.mode)}
export ADB_DOCS_CACHE_PATH=${quote(resolve(options.cache))}
${options["miss-file"] ? `export ADB_DOCS_CACHE_MISS_PATH=${quote(resolve(options["miss-file"]))}` : "unset ADB_DOCS_CACHE_MISS_PATH"}
exec ${adapter} "$@"
`, { mode: 0o700, flag: "wx" });
const wrappedExec = join(directory, "exec");
writeFileSync(wrappedExec, source.replace(/^export ADB_EXPERIMENT_BIN=.*$/m, `export ADB_EXPERIMENT_BIN=${quote(wrappedAdapter)}`), { mode: 0o700, flag: "wx" });
const child = spawnSync(wrappedExec, args, { stdio: "inherit" });
if (child.error) throw child.error;
process.exit(child.status ?? 1);
