"""The queue worker, exercised against a stub queue server and a stub `nix-build`
(ADB_WORKER_BUILD) — the full register -> claim -> execute -> report -> done loop
with no nix and no adb-web involved. The stub experiment binary records its argv,
so the test pins the job-spec -> runner-argv mapping end to end."""

import json
import stat
import threading

import pytest
from http.server import BaseHTTPRequestHandler, HTTPServer

from adb_runner.worker import _job_args, worker_cli

JOB = {"id": "j1", "experiment": "hello",
       "sets": ["x=1", "model=mockllm/model"],
       "profiles": {"openai": "work"}, "replicates": 2}


def test_job_args_mapping():
    assert _job_args(JOB) == [
        "--json", "--replicates", "2",
        "--set", "x=1", "--set", "model=mockllm/model",
        "--profile", "openai=work",
    ]
    assert _job_args({"id": "j", "experiment": "e"}) == ["--json", "--replicates", "1"]


class StubQueue(BaseHTTPRequestHandler):
    """One job, then 204s. Records everything for the assertions."""
    seen: dict = {}

    def do_POST(self):
        length = int(self.headers.get("content-length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}")
        seen = type(self).seen
        if self.path == "/api/executor/claim":
            seen["auth"] = self.headers.get("x-adb-executor")
            if not seen.get("claimed"):
                seen["claimed"] = True
                return self._json(JOB)
            self.send_response(204)
            self.end_headers()
            return
        if self.path == "/api/jobs/j1/report":
            seen.setdefault("reports", []).append(body)
            return self._json({"stop": seen.get("stop", False)})
        if self.path == "/api/jobs/j1/done":
            seen["done"] = body
            return self._json({"ok": True})
        self.send_response(404)
        self.end_headers()

    def _json(self, doc):
        payload = json.dumps(doc).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *a):  # keep pytest output clean
        pass


def test_worker_loop_end_to_end(tmp_path, monkeypatch):
    # the stub "experiment binary": records argv, emits two runs' envelopes
    exp = tmp_path / "exp-bin"
    exp.write_text(f"""#!/bin/sh
echo "$@" > {tmp_path}/argv
echo '{{"v":0,"ts":"t","run":"RUN1","seq":0,"event":{{"type":"run.start"}}}}'
echo '{{"v":0,"ts":"t","run":"RUN1","seq":1,"event":{{"type":"run.end","state":"completed"}}}}'
echo '{{"v":0,"ts":"t","run":"RUN2","seq":0,"event":{{"type":"run.start"}}}}'
echo not-json-narration
echo "runner narration" >&2
exit 0
""")
    exp.chmod(exp.stat().st_mode | stat.S_IEXEC)
    # the stub "nix-build": narrates on stderr, prints the store path on stdout
    build = tmp_path / "stub-nix-build"
    build.write_text(f"#!/bin/sh\necho building the thing >&2\necho {exp}\nexit 0\n")
    build.chmod(build.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv("ADB_WORKER_BUILD", str(build))
    monkeypatch.setenv("ADB_EXECUTOR_CAPABILITY", "s3cret")
    monkeypatch.setenv("ADB_DATA_DIR", str(tmp_path / "home"))
    monkeypatch.setenv("ADB_CREDENTIALS_FILE", str(tmp_path / "credentials.toml"))
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "config"))

    StubQueue.seen = {}
    server = HTTPServer(("127.0.0.1", 0), StubQueue)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        code = worker_cli([
            "--server", f"http://127.0.0.1:{server.server_port}",
            "--repo", str(tmp_path), "--once"])
    finally:
        server.shutdown()
    assert code == 0

    seen = StubQueue.seen
    assert seen["auth"] == "s3cret"
    # the claimed spec became exactly the runner argv (one-encoder parity holds
    # through the queue: the --set strings pass through verbatim)
    argv = (tmp_path / "argv").read_text().split()
    assert argv == ["--json", "--replicates", "2", "--set", "x=1",
                    "--set", "model=mockllm/model", "--profile", "openai=work"]
    # run ids were REPORTED from run.start envelopes; narration became log lines
    reported_runs = [r for rep in seen["reports"] for r in rep.get("runs", [])]
    assert reported_runs == ["RUN1", "RUN2"]
    logs = [line for rep in seen["reports"] for line in rep.get("log", [])]
    assert any("building the thing" in line for line in logs)
    assert any("runner narration" in line for line in logs)
    assert any("run RUN1 completed" in line for line in logs)
    states = [rep["state"] for rep in seen["reports"] if "state" in rep]
    assert states[:2] == ["building", "running"]
    assert seen["done"] == {"state": "completed", "exit_code": 0}


def test_worker_reports_failed_build(tmp_path, monkeypatch):
    build = tmp_path / "stub-nix-build"
    build.write_text("#!/bin/sh\necho no attribute >&2\nexit 1\n")
    build.chmod(build.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv("ADB_WORKER_BUILD", str(build))
    monkeypatch.setenv("ADB_EXECUTOR_CAPABILITY", "test-capability")
    monkeypatch.setenv("ADB_DATA_DIR", str(tmp_path / "home"))

    StubQueue.seen = {}
    server = HTTPServer(("127.0.0.1", 0), StubQueue)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        code = worker_cli(["--server", f"http://127.0.0.1:{server.server_port}",
                           "--repo", str(tmp_path), "--once"])
    finally:
        server.shutdown()
    assert code == 0  # a bad job is a job outcome, never a worker crash
    assert StubQueue.seen["done"]["state"] == "error"
    logs = [line for rep in StubQueue.seen["reports"] for line in rep.get("log", [])]
    assert any("no attribute" in line for line in logs)


def test_plan_build():
    from adb_runner.worker import plan_build
    # a checkout path and a tarball URL are both just the nix-build source ARG
    assert plan_build("/src", "hello", "nix-build") == \
        ["nix-build", "/src", "--no-out-link", "-A", "exec.hello"]
    assert plan_build("https://u/a.tar.gz", "hello", "nix-build") == \
        ["nix-build", "https://u/a.tar.gz", "--no-out-link", "-A", "exec.hello"]


def test_stop_kills_group_even_when_leader_exits(tmp_path, monkeypatch):
    """The run leader can exit on INT while a descendant ignores both INT/TERM."""
    import os
    import signal
    import subprocess
    import sys
    import time
    from adb_runner import worker

    pid_file = tmp_path / "descendant"
    script = tmp_path / "tree.py"
    script.write_text('''import os, signal, time, sys
if os.fork() == 0:
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    open(sys.argv[1], 'w').write(str(os.getpid()))
    while True: time.sleep(1)
while True: time.sleep(1)
''')
    proc = subprocess.Popen([sys.executable, str(script), str(pid_file)],
                            start_new_session=True, stderr=subprocess.DEVNULL)
    try:
        deadline = time.monotonic() + 5
        while not pid_file.exists() and time.monotonic() < deadline:
            time.sleep(0.02)
        assert pid_file.exists()
        descendant = int(pid_file.read_text())
        monkeypatch.setattr(worker, "_active", proc)
        started = time.monotonic()
        worker._interrupt_active()
        assert time.monotonic() - started < 6
        assert proc.poll() is not None
        # A killed orphan can remain a zombie until init reaps it.
        status = __import__('pathlib').Path(f"/proc/{descendant}/stat")
        if status.exists():
            assert status.read_text().split()[2] == "Z"
        else:
            try:
                os.kill(descendant, 0)
            except ProcessLookupError:
                pass
            else:
                raise AssertionError("descendant survived teardown")
    finally:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        proc.wait(timeout=5)


def test_worker_requires_managed_context(monkeypatch):
    monkeypatch.delenv("ADB_EXECUTOR_CAPABILITY", raising=False)
    assert worker_cli(["--server", "http://127.0.0.1:1", "--repo", "/tmp"]) == 2


@pytest.mark.parametrize("stage", ["build", "run"])
@pytest.mark.parametrize("stop_mode", ["parent-death", "stop-button", "shutdown"])
def test_supervised_teardown(tmp_path, monkeypatch, stage, stop_mode):
    import os
    import signal
    import subprocess
    import sys
    import time

    build = tmp_path / "hung-build"
    build_pid = tmp_path / "build.pid"
    build.write_text(f'''#!{sys.executable}
import os, signal, time
signal.signal(signal.SIGINT, signal.SIG_IGN)
signal.signal(signal.SIGTERM, signal.SIG_IGN)
open({str(build_pid)!r}, 'w').write(str(os.getpid()))
while True: time.sleep(1)
''')
    build.chmod(0o755)
    if stage == "run":
        launcher = tmp_path / "successful-build"
        launcher.write_text(f"#!/bin/sh\nprintf '%s\\n' '{build}'\n")
        launcher.chmod(0o755)
        monkeypatch.setenv("ADB_WORKER_BUILD", str(launcher))
    else:
        monkeypatch.setenv("ADB_WORKER_BUILD", str(build))
    monkeypatch.setenv("ADB_EXECUTOR_CAPABILITY", "test")
    monkeypatch.setenv("ADB_DATA_DIR", str(tmp_path / "home"))
    StubQueue.seen = {}
    server = HTTPServer(("127.0.0.1", 0), StubQueue)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    executor_args = ["-m", "adb_runner.worker",
                     "--server", f"http://127.0.0.1:{server.server_port}",
                     "--repo", str(tmp_path), "--once"]
    worker_pid = tmp_path / "worker.pid"
    supervisor_code = f'''import subprocess, sys, time
p = subprocess.Popen([sys.executable, *{executor_args!r}])
open({str(worker_pid)!r}, 'w').write(str(p.pid))
time.sleep(100)
'''
    supervisor = subprocess.Popen([sys.executable, "-c", supervisor_code],
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        deadline = time.monotonic() + 5
        while not build_pid.exists() and time.monotonic() < deadline:
            time.sleep(.05)
        assert build_pid.exists(), "executor never began build"
        pid = int(build_pid.read_text())
        if stop_mode == "parent-death":
            supervisor.kill()
            supervisor.wait(timeout=2)
        elif stop_mode == "stop-button":
            StubQueue.seen["stop"] = True
        else:
            os.kill(int(worker_pid.read_text()), signal.SIGTERM)
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                break
            time.sleep(.05)
        else:
            raise AssertionError("build survived its local server")
        deadline = time.monotonic() + 3
        while "done" not in StubQueue.seen and time.monotonic() < deadline:
            time.sleep(.05)
        assert StubQueue.seen["done"]["state"] == "stopped"
    finally:
        if supervisor.poll() is None:
            supervisor.kill()
            supervisor.wait(timeout=2)
        for file in [build_pid, worker_pid]:
            if file.exists():
                try:
                    os.kill(int(file.read_text()), signal.SIGKILL)
                except ProcessLookupError:
                    pass
        server.shutdown()


@pytest.mark.parametrize("script,run_state,exit_code,run_count", [
    ("exit 0", "completed", 0, 2),
    ("exit 3", "failed", 1, 2),
    ("exit 124", "failed", 1, 2),  # an experiment's timeout exit
    ("kill -TERM $$", "interrupted", 130, 1),
])
def test_experiment_outcome_reaches_cli_and_queue(
        tmp_path, monkeypatch, script, run_state, exit_code, run_count):
    """A real experiment -> runner subprocess -> queue must agree on failure."""
    import sys

    manifest = tmp_path / "manifest.json"
    manifest.write_text(json.dumps({"name": "fixture", "params": {}}))
    experiment = tmp_path / "experiment"
    experiment.write_text(f"#!/bin/sh\n{script}\n")
    experiment.chmod(0o755)
    launcher = tmp_path / "runner"
    launcher.write_text(f"#!{sys.executable}\nfrom adb_runner.cli import main\nraise SystemExit(main())\n")
    launcher.chmod(0o755)
    build = tmp_path / "build"
    build.write_text(f"#!/bin/sh\nprintf '%s\\n' '{launcher}'\n")
    build.chmod(0o755)
    home = tmp_path / "home"
    for key, value in {
        "ADB_MANIFEST": manifest, "ADB_EXPERIMENT_BIN": experiment,
        "ADB_WORKER_BUILD": build, "ADB_EXECUTOR_CAPABILITY": "test",
        "ADB_DATA_DIR": home, "ADB_CREDENTIALS_FILE": tmp_path / "credentials.toml",
    }.items():
        monkeypatch.setenv(key, str(value))
    monkeypatch.setitem(JOB, "sets", [])
    monkeypatch.setitem(JOB, "profiles", {})
    StubQueue.seen = {}
    server = HTTPServer(("127.0.0.1", 0), StubQueue)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        assert worker_cli(["--server", f"http://127.0.0.1:{server.server_port}",
                           "--repo", str(tmp_path), "--once"]) == 0
    finally:
        server.shutdown()
    assert StubQueue.seen["done"] == {
        "state": "completed" if exit_code == 0 else "failed", "exit_code": exit_code}
    records = list(home.glob("runs/*/*/run.json"))
    assert len(records) == run_count
    for path in records:
        record = json.loads(path.read_text())
        assert record["state"] == run_state and "phase" not in record
        events = [json.loads(line)["event"]
                  for chunk in sorted(path.parent.glob("events-*.jsonl"))
                  for line in chunk.read_text().splitlines()]
        assert events[-1]["state"] == run_state
        assert "phase" not in events[-1]
