"""Private single-machine executor, supervised by adb-local's server.

The server provides an exact endpoint, source, home, and private capability.
The direct experiment CLI does not depend on this protocol.
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from typing import IO, Literal

from adb_events import Json


JobState = Literal["queued", "building", "running", "completed", "failed", "stopped", "error"]


CLAIM_HOLD_S = 25          # server holds a claim open this long; timeout adds margin
REPORT_EVERY_S = 1.0       # progress/log batch cadence (also the stop-poll cadence)
LOG_BATCH_CAP = 200        # lines per report — the server tails anyway

# the job subprocess currently running (build or experiment), so a worker-level
# interrupt can pass the Ctrl-C on before exiting — partial runs are kept
_active: subprocess.Popen[str] | None = None


def _interrupt_active() -> None:
    """Bounded teardown of the entire build/run group, even if its leader exits."""
    if _active is None:
        return
    for sig, grace in ((signal.SIGINT, 2.0), (signal.SIGTERM, 2.0), (signal.SIGKILL, 0.5)):
        try:
            os.killpg(_active.pid, sig)
        except ProcessLookupError:
            break
        deadline = time.monotonic() + grace
        while time.monotonic() < deadline:
            _active.poll()  # reap leader, but do not mistake that for an empty group
            try:
                os.killpg(_active.pid, 0)
            except ProcessLookupError:
                return
            time.sleep(0.05)
    try:
        _active.wait(timeout=1)
    except subprocess.TimeoutExpired:
        pass


def _log(msg: str) -> None:
    print(f"adb-local executor: {msg}", file=sys.stderr)


class Client:
    def __init__(self, base: str, token: str | None):
        self.base = base.rstrip("/")
        self.token = token
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def call(self, method: str, path: str, payload: dict[str, Json] | None = None,
             timeout: float = 15.0) -> tuple[int, dict[str, Json] | None]:
        headers = {"content-type": "application/json"}
        if self.token:
            headers["x-adb-executor"] = self.token
        req = urllib.request.Request(
            self.base + path,
            data=json.dumps(payload).encode() if payload is not None else None,
            headers=headers, method=method)
        try:
            with self.opener.open(req, timeout=timeout) as r:
                body = r.read()
                return r.status, self._doc(body)
        except urllib.error.HTTPError as e:
            try:
                return e.code, self._doc(e.read())
            except ValueError:
                return e.code, None

    @staticmethod
    def _doc(body: bytes) -> dict[str, Json] | None:
        """The server's reply as a JSON object, or None — a non-object reply is a
        protocol violation treated as no document."""
        if not body:
            return None
        parsed: Json = json.loads(body)
        return parsed if isinstance(parsed, dict) else None


def _job_args(job: dict[str, Json]) -> list[str]:
    """The claimed spec as runner argv — the same `--set key=value` strings the
    oneliner carries (one encoder upstream guarantees it), plus profile NAMES."""
    args = ["--json", "--replicates", str(job.get("replicates") or 1)]
    sets = job.get("sets")
    if isinstance(sets, list):
        for entry in sets:
            args += ["--set", str(entry)]
    profiles = job.get("profiles")
    if isinstance(profiles, dict):
        for set_name, profile in sorted(profiles.items()):
            args += ["--profile", f"{set_name}={profile}"]
    return args


def plan_build(source: str, experiment: str, build_cmd: str) -> list[str]:
    """Build the experiment from the source selected at local ADB startup."""
    return [build_cmd, source, "--no-out-link", "-A", f"exec.{experiment}"]


class Reporter:
    """Batched progress: lines and run ids accumulate, one POST per cadence tick
    (or on demand for a state change). The reply's {stop: true} is how the stop
    button reaches a job — reporting IS the command channel, no second socket."""

    def __init__(self, client: Client, job_id: str):
        self.client = client
        self.job_id = job_id
        self.lines: list[str] = []
        self.runs: list[str] = []
        self.last = 0.0
        self.stop = False

    def line(self, text: str) -> None:
        self.lines.append(text)
        del self.lines[:-LOG_BATCH_CAP]

    def run_id(self, rid: str) -> None:
        if rid not in self.runs:
            self.runs.append(rid)

    def flush(self, state: JobState | None = None, force: bool = False) -> bool:
        now = time.monotonic()
        if not force and state is None and now - self.last < REPORT_EVERY_S:
            return self.stop
        payload: dict[str, Json] = {}
        if state:
            payload["state"] = state
        if self.lines:
            payload["log"] = list(self.lines)
            self.lines = []
        if self.runs:
            payload["runs"] = list(self.runs)
            self.runs = []
        self.last = now
        try:
            status, doc = self.client.call(
                "POST", f"/api/jobs/{self.job_id}/report", payload)
        except OSError:
            return self.stop  # transient; the next tick retries
        if status == 200 and isinstance(doc, dict) and doc.get("stop"):
            self.stop = True
        return self.stop


def _stream_lines(pipe: IO[str], on_line: Callable[[str], None]) -> None:
    for line in pipe:
        line = line.rstrip("\n")
        if line:
            on_line(line)


def execute(client: Client, job: dict[str, Json], *, repo: str,
            build_cmd: str) -> None:
    """One claimed job, start to done. Failures are job outcomes, never worker
    crashes — the worker survives every bad job."""
    job_id = str(job["id"])
    report = Reporter(client, job_id)
    _log(f"job {job_id}: {job['experiment']} ({job.get('replicates', 1)} replicate(s))")

    # step 1 — resolve the experiment to its executable, the same derivation the
    # user's oneliner would build, from the configured local source
    argv = plan_build(repo, str(job["experiment"]), build_cmd)
    report.flush(state="building", force=True)
    global _active
    build = subprocess.Popen(
        argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, start_new_session=True)
    _active = build
    out_lines: list[str] = []
    threads = [
        threading.Thread(target=_stream_lines, args=(build.stdout, out_lines.append), daemon=True),
        threading.Thread(target=_stream_lines, args=(build.stderr, report.line), daemon=True),
    ]
    for t in threads:
        t.start()
    while build.poll() is None:
        if report.flush():
            _interrupt_active()
        time.sleep(0.2)
    for t in threads:
        t.join(timeout=5)
    if report.stop:
        client.call("POST", f"/api/jobs/{job_id}/done", {"state": "stopped"})
        return
    if build.returncode != 0 or not (out_lines and out_lines[-1].startswith("/")):
        report.line(f"build failed (exit {build.returncode})")
        report.flush(force=True)
        client.call("POST", f"/api/jobs/{job_id}/done",
                    {"state": "error", "exit_code": build.returncode})
        return
    bin_path = out_lines[-1]

    # step 2 — the built experiment app, headless: stdin closed (the runner never
    # prompts a worker), stdout is the --json event stream that drives this record
    child = subprocess.Popen(
        [bin_path] + _job_args(job),
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, start_new_session=True,
        env={**os.environ, "ADB_DATA_DIR": os.environ.get(
            "ADB_DATA_DIR", os.path.expanduser("~/.local/share/adb"))})
    _active = child
    report.flush(state="running", force=True)

    def on_stdout(line: str) -> None:
        try:
            envelope: Json = json.loads(line)
        except ValueError:
            return  # not ours to interpret
        if not isinstance(envelope, dict):
            return
        event = envelope.get("event")
        run = envelope.get("run")
        if not isinstance(event, dict) or not isinstance(run, str):
            return
        if event.get("type") == "run.start":
            report.run_id(run)
        elif event.get("type") == "run.end":
            report.line(f"run {run} {event.get('state', 'ended')}")

    threads = [
        threading.Thread(target=_stream_lines, args=(child.stdout, on_stdout), daemon=True),
        threading.Thread(target=_stream_lines, args=(child.stderr, report.line), daemon=True),
    ]
    for t in threads:
        t.start()
    stopped = False
    while child.poll() is None:
        if report.flush() and not stopped:
            stopped = True
            _interrupt_active()
        time.sleep(0.2)
    for t in threads:
        t.join(timeout=5)
    _active = None
    report.flush(force=True)
    state = "stopped" if stopped else "completed" if child.returncode == 0 else "failed"
    client.call("POST", f"/api/jobs/{job_id}/done",
                {"state": state, "exit_code": child.returncode})
    _log(f"job {job_id}: {state}")


def worker_cli(argv: list[str]) -> int:
    p = argparse.ArgumentParser(prog="python -m adb_runner.worker")
    p.add_argument("--server", required=True)
    p.add_argument("--repo", required=True)
    p.add_argument("--once", action="store_true")
    args = p.parse_args(argv)
    token = os.environ.get("ADB_EXECUTOR_CAPABILITY")
    if not token or not os.environ.get("ADB_DATA_DIR"):
        _log("this private executor must be started by adb-local")
        return 2
    client = Client(args.server, token)
    build_cmd = os.environ.get("ADB_WORKER_BUILD", "nix-build")
    parent = os.getppid()

    def _term(_sig: int, _frame: object) -> None:
        raise KeyboardInterrupt

    def watch_parent() -> None:
        while os.getppid() == parent:
            time.sleep(0.5)
        # Unexpected supervisor death must not leave an experiment running.
        os.kill(os.getpid(), signal.SIGTERM)

    previous = signal.signal(signal.SIGTERM, _term)
    watcher = threading.Thread(target=watch_parent, daemon=True)
    watcher.start()
    current: str | None = None
    try:
        while True:
            status, doc = client.call("POST", "/api/executor/claim", {}, timeout=CLAIM_HOLD_S + 10)
            if status == 200 and isinstance(doc, dict) and "id" in doc:
                current = str(doc["id"])
                try:
                    execute(client, doc, repo=args.repo, build_cmd=build_cmd)
                except OSError as exc:
                    _interrupt_active()
                    client.call("POST", f"/api/jobs/{current}/report", {"log": [str(exc)]})
                    client.call("POST", f"/api/jobs/{current}/done", {"state": "error"})
                current = None
                if args.once:
                    return 0
            elif status != 204:
                raise OSError(f"local queue refused claim ({status})")
    except KeyboardInterrupt:
        # Ignore repeated TERM while tearing down; the supervisor has its own deadline.
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        _interrupt_active()
        if current:
            try:
                client.call("POST", f"/api/jobs/{current}/done", {"state": "stopped"}, timeout=1)
            except OSError:
                pass
        return 0
    except OSError as exc:
        _interrupt_active()
        _log(f"local server unavailable: {exc}")
        return 1
    finally:
        signal.signal(signal.SIGTERM, previous)


if __name__ == "__main__":
    raise SystemExit(worker_cli(sys.argv[1:]))
