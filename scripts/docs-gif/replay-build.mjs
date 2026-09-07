#!/usr/bin/env node
/* Recording-only ADB_WORKER_BUILD hook. Builds runner/manifests, never the saved
   experiment runtime. Configuration is baked into wrappers across env filtering. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const experiment = args.pop()?.match(/^exec\.([a-zA-Z0-9_-]+)$/)?.[1];
if (!experiment) throw new Error('Expected nix-build arguments ending exec.EXPERIMENT');
const source = resolve(process.env.ADB_DOCS_REPLAY_RUN || '');
if (!process.env.ADB_DOCS_REPLAY_RUN || !process.env.ADB_DOCS_REPLAY_DIR)
  throw new Error('Set ADB_DOCS_REPLAY_RUN and ADB_DOCS_REPLAY_DIR');
const meta = JSON.parse(readFileSync(join(source, 'run.json'), 'utf8'));
if (meta.experiment !== experiment || meta.phase !== 'completed')
  throw new Error('Replay must select the captured experiment and a completed run');
const speed = Number(process.env.ADB_DOCS_REPLAY_SPEED || '1');
if (!Number.isFinite(speed) || speed <= 0) throw new Error('Replay speed must be positive and finite');
const build = attr => execFileSync('nix-build', [...args, attr], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
}).trim();
const manifests = build('manifests');
const runner = build('exec.adb-runner');
const manifest = JSON.parse(readFileSync(join(manifests, `${experiment}.json`), 'utf8'));
function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .map(([key, child]) => [key, key === 'kind' && child === 'llm' ? 'str' : sanitize(child)]));
  return value;
}
const parent = resolve(process.env.ADB_DOCS_REPLAY_DIR);
mkdirSync(parent, { recursive: true });
const work = mkdtempSync(join(parent, 'replay-'));
const manifestPath = join(work, 'manifest.json');
writeFileSync(manifestPath, JSON.stringify(sanitize(manifest)));
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
const python = execFileSync('which', ['python3'], {encoding: 'utf8'}).trim();
const adapter = join(work, 'adapter');
writeFileSync(adapter, `#!/bin/sh\nexec ${quote(python)} ${quote(join(dirname(fileURLToPath(import.meta.url)), 'replay.py'))} --run ${quote(source)} --speed ${speed}\n`, {mode: 0o700});
// Profile selections only make sense for a live experiment. The recording manifest
// retains actual model string values while disabling credential provisioning.
const entrypoint = join(work, 'exec');
writeFileSync(entrypoint, `#!${python}
import os, sys
args = iter(sys.argv[1:])
filtered = []
for arg in args:
    if arg == '--profile':
        next(args, None)
    elif not arg.startswith('--profile='):
        filtered.append(arg)
os.environ.update(${JSON.stringify({ADB_MANIFEST:manifestPath, ADB_EXPERIMENT_BIN:adapter,
  ADB_SOURCE:`dirty:docs-recording-replay:${meta.condition}:${meta.run}`,
  ADB_FETCH_REF:`dirty:docs-recording-replay:${meta.run}`})})
os.execv(${JSON.stringify(runner)}, [${JSON.stringify(runner)}, *filtered])
`, {mode: 0o700});
console.log(entrypoint);
