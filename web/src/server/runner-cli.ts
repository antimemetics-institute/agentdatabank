/* Credential proxying — the server holds NO credential logic: it execs the
   runner's own machine faces (`credentials … --json`) so the store, its 0600
   permissions, and its validation stay in exactly one implementation. Plaintext
   secrets travel one way (browser → child stdin → 0600 file) and are never
   stored, logged, or echoed here.

   Same-machine only, on purpose: this edits the store of the user running the
   server, which is the same store the locally-supervised worker reads. Editing a
   REMOTE worker's store is a different feature (a write-through command on the
   worker's channel) and deliberately doesn't exist yet. */

import { spawn } from "node:child_process";

function runnerCli(
  runnerBin: string, args: string[], stdin: string | null,
): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(runnerBin, args, {
      stdio: ["pipe", "pipe", "pipe"], env: process.env,
    });
    let out = "", err = "";
    child.stdout.setEncoding("utf8"); child.stdout.on("data", (c: string) => { out += c; });
    child.stderr.setEncoding("utf8"); child.stderr.on("data", (c: string) => { err += c; });
    /* the machine faces never prompt; a closed/consumed stdin guarantees no hang,
       and the timeout guards against surprises anyway */
    if (stdin !== null) child.stdin.write(stdin);
    child.stdin.end();
    const timer = setTimeout(() => { child.kill("SIGKILL"); }, 15_000);
    child.on("error", (e) => { clearTimeout(timer); resolvePromise({ code: -1, out, err: String(e) }); });
    child.on("close", (code) => { clearTimeout(timer); resolvePromise({ code: code ?? -1, out, err }); });
  });
}

export async function credsList(runnerBin: string): Promise<unknown | null> {
  const r = await runnerCli(runnerBin, ["credentials", "list", "--json"], null);
  if (r.code !== 0) return null;
  try { return JSON.parse(r.out); } catch { return null; }
}

export async function credsSet(
  runnerBin: string, set: string, profile: string, values: Record<string, string | null>,
): Promise<{ ok: true } | { error: string }> {
  const r = await runnerCli(runnerBin,
    ["credentials", "set", `${set}.${profile}`, "--json"], JSON.stringify(values));
  return r.code === 0 ? { ok: true } : { error: r.err.trim() || "credentials set failed" };
}

export async function credsRemember(
  runnerBin: string, experiment: string, set: string, profile: string,
): Promise<{ ok: true } | { error: string }> {
  const r = await runnerCli(runnerBin, ["credentials", "remember", experiment, set, profile], null);
  return r.code === 0 ? { ok: true } : { error: r.err.trim() || "remember failed" };
}
