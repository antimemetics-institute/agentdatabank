// Development launcher: bundle/watch the API and connect Vite to its actual port.
import { context } from 'esbuild';
import { createServer } from 'vite';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

process.chdir(fileURLToPath(new URL('.', import.meta.url)));
const repo = fileURLToPath(new URL('..', import.meta.url));
const runner = execFileSync('nix-build', [repo, '--no-out-link', '-A', 'adb-runner'],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim().split('\n').at(-1);
const dir = await mkdtemp(join(tmpdir(), 'adb-web-dev-'));
let api, vite, proxy, build, stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  if (api && api.exitCode === null && api.signalCode === null) {
    const exited = new Promise(resolve => api.once('exit', resolve));
    api.kill('SIGTERM');
    await exited;
  }
  await vite?.close();
  await build?.dispose();
  await rm(dir, { recursive: true, force: true });
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
try {
  const outfile = join(dir, 'server.cjs');
  build = await context({ entryPoints: ['src/server.ts'], outfile, bundle: true, platform: 'node', format: 'cjs' });
  await build.rebuild();
  await build.watch();
  api = spawn(process.execPath, ['--watch', outfile,
    '--execution-source', repo, '--runner', join(runner, 'bin/adb-runner'),
    '--executor-python', join(runner, 'bin/python'), '--port', '0', '--no-open'],
    { stdio: ['ignore', 'pipe', 'inherit'] });
  let updates = Promise.resolve();
  createInterface({ input: api.stdout }).on('line', line => {
    console.log(line);
    const url = line.match(/^adb-web: serving .* on (http:\/\/\S+)/)?.[1];
    if (!url) return;
    updates = updates.then(async () => {
      if (stopping) return;
      if (proxy) { proxy.options.target = url; return; }
      vite = await createServer({ server: { proxy: { '/api': {
        target: url, configure(instance) { proxy = instance; },
      } } } });
      await vite.listen();
      vite.printUrls();
    }).catch(async err => { console.error(err); process.exitCode = 1; await stop(); });
  });
  api.once('exit', code => {
    if (!stopping) { process.exitCode = code || 1; void stop(); }
  });
} catch (err) {
  console.error(err);
  process.exitCode = 1;
  await stop();
}
