/** Presentation helpers; the original fields remain available in the raw view. */
export function stripAnsi(text: string): string {
  return text
    .replace(/(?:\x1b\]|\x9d)[\s\S]*?(?:\x07|\x1b\\|\x9c)/g, "")
    .replace(/\x1b[PX^_][\s\S]*?(?:\x1b\\|\x9c)/g, "")
    .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[ -/]*[@-Z\\-_]/g, "");
}

const LINUX_SIGNALS = "HUP INT QUIT ILL TRAP ABRT BUS FPE KILL USR1 SEGV USR2 PIPE ALRM TERM STKFLT CHLD CONT STOP TSTP TTIN TTOU URG XCPU XFSZ VTALRM PROF WINCH IO PWR SYS".split(" ");
const DARWIN_SIGNALS = "HUP INT QUIT ILL TRAP ABRT EMT FPE KILL BUS SEGV SYS PIPE ALRM TERM URG STOP TSTP CONT CHLD TTIN TTOU IO XCPU XFSZ VTALRM PROF WINCH INFO USR1 USR2".split(" ");

export function exitLabel(code: number, platform?: string): string {
  if (code >= 0) return `exit ${code}`;
  const number = -code;
  const darwin = /darwin|macos/i.test(platform ?? "");
  const name = (darwin ? DARWIN_SIGNALS : LINUX_SIGNALS)[number - 1];
  const signal = name ? `SIG${name}` : !darwin && number >= 34 && number <= 64
    ? `SIGRTMIN${number === 34 ? "" : `+${number - 34}`}` : `signal ${number}`;
  return `exit ${code} (${signal})`;
}

export function storePackage(path: string): string {
  return path.match(/^\/nix\/store\/[^/]+?-([^/]+)/)?.[1] ?? path;
}

/** Turn the launcher's pinned Nix GitHub reference into a browsable revision. */
export function fetchRefHref(ref: string): string | null {
  const github = ref.match(/^github:([^/?#]+)\/([^/?#]+)\/([^?#]+)(?:\?([^#]*))?$/);
  if (github) {
    const dir = new URLSearchParams(github[4]).get("dir");
    return `https://github.com/${[github[1]!, github[2]!, "tree", github[3]!,
      ...(dir ? dir.split("/") : [])].map(encodeURIComponent).join("/")}`;
  }
  const url = ref.replace(/^git\+/, "");
  return /^https?:\/\//i.test(url) ? url : null;
}
