"""The queue worker — `adb-runner worker --server URL` — mode (a) of the two
execution modes (the other is pasting a oneliner; that path never touches this
module or any queue).

One process, headless BY DESIGN: it never prompts for anything. Jobs arrive as
secret-free specs ({experiment, sets, profiles (NAMES), replicates}); credentials
resolve on THIS machine from THIS machine's store, through the runner's normal
headless ladder (explicit --profile from the job, else remembered, else default,
else the run fails with the fix in hand). At registration the worker ADVERTISES its
masked credential inventory (profile names, never values — credentials.inventory())
so a GUI can offer exactly the profiles this worker can honor and gate jobs it
can't. The same protocol later points at a hosted queue with an account token; a
hosted worker differs only in where its store comes from, not in this loop.

Lifecycle: register (name + inventory) -> long-poll claim -> execute (nix-build
`exec.<experiment>` from --repo, then the built app with --json; run ids and phases
come from the runner's OWN event envelopes, nothing is scraped) -> report batched
progress (the report reply carries the stop request; stop = SIGINT to the process
group, exactly Ctrl-C) -> done -> claim again. Server unreachable: retry with
backoff. Unknown worker id (server restarted): re-register. SIGINT to the worker
itself: forwarded to a live job, then exit.

Requests deliberately bypass proxy env vars: workers commonly talk to loopback or
LAN, where an http_proxy would swallow the request (same hazard the viewer probe
guards against).
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from typing import IO

from adb_events import Json

from . import credentials

CLAIM_HOLD_S = 25          # server holds a claim open this long; timeout adds margin
REPORT_EVERY_S = 1.0       # progress/log batch cadence (also the stop-poll cadence)
RETRY_S = 5.0              # backoff when the server is unreachable
LOG_BATCH_CAP = 200        # lines per report — the server tails anyway

RUN_ID_TYPES = ("run.start", "run.end")

# the job subprocess currently running (build or experiment), so a worker-level
# interrupt can pass the Ctrl-C on before exiting — partial runs are kept
_active: subprocess.Popen[str] | None = None


def _interrupt_active() -> None:
    if _active is not None and _active.poll() is None:
        try:
            os.killpg(_active.pid, signal.SIGINT)
            _active.wait(timeout=15)
        except (OSError, subprocess.TimeoutExpired):
            pass


def _log(msg: str) -> None:
    print(f"adb-worker: {msg}", file=sys.stderr)


class ServerGone(Exception):
    """Server restarted (or never knew us) — re-register and carry on."""


class Client:
    def __init__(self, base: str, token: str | None):
        self.base = base.rstrip("/")
        self.token = token
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def call(self, method: str, path: str, payload: dict[str, Json] | None = None,
             timeout: float = 15.0) -> tuple[int, dict[str, Json] | None]:
        headers = {"content-type": "application/json"}
        if self.token:
            headers["authorization"] = f"Bearer {self.token}"
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
    """The classic build invocation for `source` — a checkout/store path or a
    tarball URL, both of which nix-build takes in the source position. Only
    classic nix here: the oneliner palette's flakes-vs-stock split is shell
    SYNTAX for humans, not a different source. Jobs never carry a source at
    all: a worker builds from the one repo it was registered with (--repo) —
    what a worker serves is its operator's, not the submitter's."""
    return [build_cmd, source, "--no-out-link", "-A", f"exec.{experiment}"]


class Reporter:
    """Batched progress: lines and run ids accumulate, one POST per cadence tick
    (or on demand for a phase change). The reply's {stop: true} is how the stop
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

    def flush(self, phase: str | None = None, force: bool = False) -> bool:
        now = time.monotonic()
        if not force and phase is None and now - self.last < REPORT_EVERY_S:
            return self.stop
        payload: dict[str, Json] = {}
        if phase:
            payload["phase"] = phase
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
    # user's oneliner would build, from THIS worker's registered repo
    argv = plan_build(repo, str(job["experiment"]), build_cmd)
    report.flush(phase="building", force=True)
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
            os.killpg(build.pid, signal.SIGINT)
        time.sleep(0.2)
    for t in threads:
        t.join(timeout=5)
    if report.stop:
        client.call("POST", f"/api/jobs/{job_id}/done", {"phase": "stopped"})
        return
    if build.returncode != 0 or not (out_lines and out_lines[-1].startswith("/")):
        report.line(f"build failed (exit {build.returncode})")
        report.flush(force=True)
        client.call("POST", f"/api/jobs/{job_id}/done",
                    {"phase": "error", "exit_code": build.returncode})
        return
    bin_path = out_lines[-1]

    # step 2 — the built experiment app, headless: stdin closed (the runner never
    # prompts a worker), stdout is the --json event stream that drives this record
    child = subprocess.Popen(
        [bin_path] + _job_args(job),
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, start_new_session=True,
        env={**os.environ, "ADB_HOME": os.environ.get(
            "ADB_HOME", os.path.expanduser("~/.local/share/adb"))})
    _active = child
    report.flush(phase="running", force=True)

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
            report.line(f"run {run} {event.get('phase', 'ended')}")

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
            os.killpg(child.pid, signal.SIGINT)  # Ctrl-C: partial runs are kept
        time.sleep(0.2)
    for t in threads:
        t.join(timeout=5)
    _active = None
    report.flush(force=True)
    phase = "stopped" if stopped else "completed" if child.returncode == 0 else "failed"
    client.call("POST", f"/api/jobs/{job_id}/done",
                {"phase": phase, "exit_code": child.returncode})
    _log(f"job {job_id}: {phase}")


def _probe_server(patience_s: float = 10.0) -> str | None:
    """No --server given: find the local adb-web the same way the runner's viewer
    probe does — walk the ports it binds (8340 upward), keep the first thing that
    answers the identity ping. A short patience window covers being started
    TOGETHER with adb-web (adb-up) before its port is bound."""
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    deadline = time.monotonic() + patience_s
    said = False
    while True:
        for port in range(8340, 8344):
            base = f"http://127.0.0.1:{port}"
            try:
                with opener.open(f"{base}/api/ping", timeout=0.3) as r:
                    body: Json = json.loads(r.read(4096))
            except (OSError, ValueError):
                continue
            if isinstance(body, dict) and body.get("adb") == "web":
                return base
        if time.monotonic() >= deadline:
            return None
        if not said:
            _log("waiting for a local adb-web on 127.0.0.1:8340-8343…")
            said = True
        time.sleep(0.5)


def register(client: Client, name: str) -> str:
    status, doc = client.call("POST", "/api/workers/register",
                              {"name": name, "creds": credentials.inventory()})
    worker_id = doc.get("worker") if doc else None
    if status != 200 or not isinstance(worker_id, str):
        raise OSError(f"register failed ({status}): {doc}")
    _log(f"registered as {name!r} ({worker_id}) at {client.base}")
    return worker_id


def worker_cli(argv: list[str]) -> int:
    p = argparse.ArgumentParser(prog="adb-worker")
    p.add_argument("--server", default=None, metavar="URL",
                   help="the queue to serve (an adb-web instance); omitted, the "
                        "local viewer ports (8340+) are probed")
    p.add_argument("--name", default=socket.gethostname(),
                   help="how this worker introduces itself (default: hostname)")
    p.add_argument("--repo", default=os.environ.get("ADB_WORKER_REPO"),
                   metavar="SRC", help="adb source to nix-build experiments from: a "
                   "checkout/store path, or a tarball URL (e.g. a github archive) "
                   "(default: $ADB_WORKER_REPO, baked by the nix adb-worker wrapper "
                   "to the same pinned source the worker was built from)")
    p.add_argument("--token-file", default=None, metavar="FILE",
                   help="bearer token for a non-loopback server (file, not argv — "
                   "argv is visible in `ps`); also: $ADB_WORKER_TOKEN")
    p.add_argument("--once", action="store_true",
                   help="execute one job then exit (tests, batch cron)")
    args = p.parse_args(argv)
    if not args.repo:
        _log("no --repo / $ADB_WORKER_REPO — nothing to build experiments from")
        return 2
    if args.server is None:
        args.server = _probe_server()
        if args.server is None:
            _log("no adb-web found on 127.0.0.1:8340-8343 — start one "
                 "(nix run .#adb-web) or point me somewhere: --server URL")
            return 2
        _log(f"found the local adb-web at {args.server}")
    token = os.environ.get("ADB_WORKER_TOKEN")
    if args.token_file:
        token = open(args.token_file).read().strip()
    client = Client(args.server, token)
    # tests point this at a stub; everything else is the real nix-build
    build_cmd = os.environ.get("ADB_WORKER_BUILD", "nix-build")

    # a supervisor's TERM (systemd, adb-local's teardown trap) is the same request
    # as Ctrl-C: stop gracefully. Mapping it onto KeyboardInterrupt reuses the one
    # shutdown path — including SIGINT-ing a live job's process group below.
    def _term(_sig: int, _frame: object) -> None:
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, _term)

    worker_id: str | None = None
    while True:
        try:
            if worker_id is None:
                worker_id = register(client, args.name)
            status, doc = client.call(
                "POST", f"/api/workers/{worker_id}/claim", {},
                timeout=CLAIM_HOLD_S + 10)
            if status == 410:
                raise ServerGone()
            if status == 200 and isinstance(doc, dict) and "id" in doc:
                execute(client, doc, repo=args.repo, build_cmd=build_cmd)
                if args.once:
                    return 0
            elif status not in (200, 204):
                _log(f"claim: unexpected {status} — retrying in {RETRY_S:.0f}s")
                time.sleep(RETRY_S)
        except ServerGone:
            _log("server no longer knows this worker (restart?) — re-registering")
            worker_id = None
        except KeyboardInterrupt:
            _interrupt_active()  # pass the Ctrl-C on to a live job; partial runs kept
            _log("interrupted — bye")
            return 0
        except OSError as exc:
            _log(f"server unreachable ({exc}) — retrying in {RETRY_S:.0f}s")
            worker_id = None
            time.sleep(RETRY_S)
