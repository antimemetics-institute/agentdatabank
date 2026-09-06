/* One owned Python process. It receives the same environment as credential CLI
   calls, plus an explicit store and a private per-launch protocol capability. */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";

export class LocalExecutor {
  readonly capability = randomBytes(32).toString("hex");
  private child: ChildProcess | null = null;
  private stopping = false;
  ready = false;
  error: string | null = null;

  private readonly onExit: () => void;
  constructor(onExit: () => void) { this.onExit = onExit; }

  start(python: string, endpoint: string, repo: string, home: string): void {
    const child = spawn(python, ["-m", "adb_runner.worker", "--server", endpoint, "--repo", repo], {
      stdio: ["ignore", "inherit", "inherit"],
      detached: true, // terminal signals go through the owning server exactly once
      env: { ...process.env, ADB_DATA_DIR: home, ADB_EXECUTOR_CAPABILITY: this.capability },
    });
    this.child = child;
    child.once("error", (err) => { this.error = err.message; });
    child.once("close", (code, signal) => {
      this.child = null;
      this.ready = false;
      if (!this.stopping) this.error ??= `Local executor exited (${signal ?? code}); restart adb-local.`;
      this.onExit();
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.ready = false;
    const child = this.child;
    if (!child) return;
    await new Promise<void>((resolve) => {
      const deadline = setTimeout(() => child.kill("SIGKILL"), 10_000);
      child.once("close", () => { clearTimeout(deadline); resolve(); });
      child.kill("SIGTERM");
    });
  }
}
