"""The queue worker, exercised against a stub queue server and a stub `nix-build`
(ADB_WORKER_BUILD) — the full register -> claim -> execute -> report -> done loop
with no nix and no adb-web involved. The stub experiment binary records its argv,
so the test pins the job-spec -> runner-argv mapping end to end."""

import json
import stat
import threading
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
        if self.path == "/api/workers/register":
            seen["register"] = body
            seen["auth"] = self.headers.get("authorization")
            return self._json({"worker": "w-1"})
        if self.path == "/api/workers/w-1/claim":
            if not seen.get("claimed"):
                seen["claimed"] = True
                return self._json(JOB)
            self.send_response(204)
            self.end_headers()
            return
        if self.path == "/api/jobs/j1/report":
            seen.setdefault("reports", []).append(body)
            return self._json({"stop": False})
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
echo '{{"v":0,"ts":"t","run":"RUN1","seq":1,"event":{{"type":"run.end","phase":"completed"}}}}'
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
    monkeypatch.setenv("ADB_WORKER_TOKEN", "s3cret")
    monkeypatch.setenv("ADB_CREDENTIALS_FILE", str(tmp_path / "credentials.toml"))
    monkeypatch.setenv("ADB_PREFERENCES_FILE", str(tmp_path / "preferences.toml"))

    StubQueue.seen = {}
    server = HTTPServer(("127.0.0.1", 0), StubQueue)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        code = worker_cli([
            "--server", f"http://127.0.0.1:{server.server_port}",
            "--repo", str(tmp_path), "--name", "testbox", "--once"])
    finally:
        server.shutdown()
    assert code == 0

    seen = StubQueue.seen
    # registration advertises the masked inventory and carries the bearer token
    assert seen["register"]["name"] == "testbox"
    assert "store" in seen["register"]["creds"] and "providers" in seen["register"]["creds"]
    assert seen["auth"] == "Bearer s3cret"
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
    phases = [rep["phase"] for rep in seen["reports"] if "phase" in rep]
    assert phases[:2] == ["building", "running"]
    assert seen["done"] == {"phase": "completed", "exit_code": 0}


def test_worker_reports_failed_build(tmp_path, monkeypatch):
    build = tmp_path / "stub-nix-build"
    build.write_text("#!/bin/sh\necho no attribute >&2\nexit 1\n")
    build.chmod(build.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv("ADB_WORKER_BUILD", str(build))
    monkeypatch.delenv("ADB_WORKER_TOKEN", raising=False)

    StubQueue.seen = {}
    server = HTTPServer(("127.0.0.1", 0), StubQueue)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        code = worker_cli(["--server", f"http://127.0.0.1:{server.server_port}",
                           "--repo", str(tmp_path), "--once"])
    finally:
        server.shutdown()
    assert code == 0  # a bad job is a job outcome, never a worker crash
    assert StubQueue.seen["done"]["phase"] == "error"
    logs = [line for rep in StubQueue.seen["reports"] for line in rep.get("log", [])]
    assert any("no attribute" in line for line in logs)


def test_plan_build():
    from adb_runner.worker import plan_build
    # a checkout path and a tarball URL are both just the nix-build source ARG
    assert plan_build("/src", "hello", "nix-build") == \
        ["nix-build", "/src", "--no-out-link", "-A", "exec.hello"]
    assert plan_build("https://u/a.tar.gz", "hello", "nix-build") == \
        ["nix-build", "https://u/a.tar.gz", "--no-out-link", "-A", "exec.hello"]
