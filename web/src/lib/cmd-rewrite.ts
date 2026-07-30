/* Pure `nix run .#…` command rewriting, ported line-for-line from the docs gear
   menu (docs/book/theme/adb-commands.js) — the two implementations must stay in
   step so a command copied from the webui matches the guide. Commands are
   composed in the canonical local form `nix run .#<name> …`; rewriteCmd() adapts
   that text to the user's Nix setup. Storage + React binding live in
   lib/cmd-prefs.ts; this module stays DOM-free so node tests cover it. */

export type CmdPrefs = {
  // mode tabs: "flakes" (nix run, armored until flakes are global), "nix-build"
  // (stock-nix $(nix-build …)/exec one-liner), "nix-run" (classic runner;
  // nixRun = installed globally, else nix-shell-wrapped)
  mode: "flakes" | "nix-build" | "nix-run";
  source: "github" | "local";
  flakes: boolean;
  registry: boolean;
  nixRun: boolean;
  // github source only: bypass Nix's download cache so a rerun picks up new
  // commits on main (tarball-ttl 0 / --refresh). Inert for a local checkout.
  latest: boolean;
};

/* flakes:false by default — commands must work on a stock Nix install, so they
   carry an explicit --extra-experimental-features until the user says it's
   enabled globally. nixRun:false likewise: the wrapped nix-shell form works
   without anything installed. latest:true — a stale cached main.tar.gz silently
   running old code is worse than a redundant HEAD check. */
export const CMD_PREFS_DEFAULTS: CmdPrefs = {
  mode: "nix-build",
  source: "github",
  flakes: false,
  registry: false,
  nixRun: false,
  latest: true,
};

/* External experiments (manifest origin "external") live in the author's own
   repo — the adb github/tarball sources cannot name them, so the palette does
   not apply: their oneliner is always the repo-local stock-nix form the
   scaffold README teaches, run from the experiment's own directory. */
export const REPO_LOCAL_PREFS: CmdPrefs = {
  mode: "nix-build",
  source: "local",
  flakes: false,
  registry: false,
  nixRun: false,
  latest: false,
};

const GITHUB = "github:antimemetics-institute/agentdatabank";
const TARBALL = "https://github.com/antimemetics-institute/agentdatabank/archive/main.tar.gz";
const ARMOR = " --extra-experimental-features 'nix-command flakes'";

function ref(p: CmdPrefs): string {
  if (p.source === "local") return ".";
  return p.registry ? "adb" : GITHUB;
}

/* flakeless heads, two flavors:
    nix-run:   `nix-run <src> -A experiment-<name> -- args` — resolves
               meta.mainProgram itself, takes program args after `--` (which our
               commands already carry, so only the head token changes)
    nix-build: `$(nix-build --no-out-link [<src>] -A exec.<name>) args` — the
               exec.* output IS the executable, so the `--` separator is dropped
   The tarball URL is long enough to push the -A target off-screen, so the
   github-source forms continue onto a fresh line before it (backslash-newline
   holds inside $(…) and inside the nix-shell --run double quotes alike). */
function flakelessHead(cmd: string, p: CmdPrefs): string {
  // "always fetch latest" spellings: nix-build takes the setting as a flag;
  // nix-run only documents --option. Only the github tarball is ever cached.
  const fresh = p.source === "github" && p.latest;
  if (p.mode === "nix-build") {
    cmd = cmd.replace(/^nix run \.#(\S+)/, (_, name: string) => {
      const ttl = fresh ? " --tarball-ttl 0" : "";
      const src = p.source === "local" ? " " : " " + TARBALL + " \\\n  ";
      return `$(nix-build --no-out-link${ttl}${src}-A exec.${name})`;
    });
    return cmd.replace(/(-A exec\.\S+\)) --(?=\s|$)/, "$1");
  }
  return cmd.replace(/^nix run \.#(\S+)/, (_, name: string) => {
    const pkg = name.startsWith("adb-") ? name : `experiment-${name}`;
    const ttl = fresh ? "--option tarball-ttl 0 " : "";
    const src = p.source === "local" ? ". " : TARBALL + " \\\n  ";
    return `nix-run ${ttl}${src}-A ${pkg}`;
  });
}

function rewriteLine(line: string, p: CmdPrefs): string {
  const idx = line.indexOf("nix run .#");
  if (idx === -1) return line;
  const before = line.slice(0, idx);
  let cmd = line.slice(idx);
  if (p.mode === "nix-build" || p.mode === "nix-run") return before + flakelessHead(cmd, p);
  cmd = cmd.replace(/^nix run \.#(\S+)/, (_, name: string) => {
    let head = `nix run ${ref(p)}#${name}`;
    // the flags trail the installable (before any `--`), so the command reads
    // action-first: `nix run adb#inspect-hello --extra-experimental-features … -- …`
    if (!p.flakes) head += ARMOR;
    if (p.source === "github" && p.latest) head += " --refresh";
    return head;
  });
  return before + cmd;
}

/* Block-level pass: commands span multiple lines via trailing backslashes, and
   the no-nix-run-installed form must wrap the WHOLE span in
     nix-shell -p nix-run --run "…"
   (inside double quotes backslash-newline still continues the line, and our
   values only ever carry single quotes, so the nesting is paste-safe). */
export function rewriteCmd(text: string, p: CmdPrefs): string {
  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const idx = line.indexOf("nix run .#");
    if (idx === -1) {
      out.push(line);
      continue;
    }
    const span = [line];
    while (/\\\s*$/.test(span[span.length - 1]!) && i + 1 < lines.length) {
      i++;
      span.push(lines[i]!);
    }
    const before = line.slice(0, idx);
    let head = rewriteLine(line, p);
    const tail = span.slice(1);
    if (p.mode === "nix-run" && !p.nixRun) {
      head = before + 'nix-shell -p nix-run --run "' + head.slice(before.length);
      if (tail.length) tail[tail.length - 1] += '"';
      else head += '"';
    }
    out.push(head, ...tail);
  }
  return out.join("\n");
}

export function previewCmd(p: CmdPrefs): string {
  return rewriteCmd("nix run .#inspect-hello -- …", p);
}
