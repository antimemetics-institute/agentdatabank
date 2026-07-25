"""The runner protocol: spawn the experiment, feed params, envelope + persist events.

runner → experiment: realized params JSON on stdin; ADB_RUN_ID/ADB_RUN_DIR/ADB_SEED env;
fresh workspace as cwd; a small env allowlist (never the full host environment).
experiment → runner: event payloads as JSON objects on stdout, one per line — each is
wrapped verbatim in the transport envelope {v, ts, run, seq, event} (specs/events.md);
`type` is optional (conformance ladder: unknown or absent types are preserved). Non-JSON
stdout lines become `stdout` events, stderr lines `stderr` events — nothing a process
can print breaks a run. Exit code 0 → completed, nonzero → failed, signal → interrupted.
"""

from __future__ import annotations

import datetime
import fnmatch
import json
import os
import queue
import signal
import subprocess
import threading
import time

from . import __version__
from . import providers
from .events_schema import validate_event
from .store import RunStore
from .ulid import ulid

# DOCKER_HOST: sandboxed experiments must find the machine's docker daemon (a
# per-user rootless socket on dev boxes — see `task docker:up`); like provider
# endpoints, where the daemon lives is environment, never condition identity.
ENV_ALLOWLIST = ["PATH", "HOME", "LANG", "LC_ALL", "TERM", "TMPDIR", "DOCKER_HOST"]
ENV_ALLOW_PATTERNS = ["*_API_KEY", "*_API_BASE", "*_BASE_URL", "AWS_*", "AZURE_*"]

# Liveness heartbeat: while the experiment runs, the runner touches run.json's mtime
# (content unchanged — no deposit churn, nothing in the event stream; liveness is
# operational state, not experimental data). Consumers: running + stale mtime =
# crashed ("interrupted?" per specs/events.md); experiments never know it exists.
HEARTBEAT_S = 10.0


def _now() -> str:
    return (
        datetime.datetime.now(datetime.timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def child_env(run_id: str, run_dir: str, seed: int, provider_env: dict | None = None) -> dict:
    # stored provider credentials/endpoints (providers.py) are the base; an explicit host
    # env var of the same name overrides (so CI / a deliberate `export` still wins), and
    # ADB_* are set last. This is how a real model reaches its key without the key ever
    # appearing on the command line.
    env = dict(provider_env or {})
    for key, value in os.environ.items():
        if key in ENV_ALLOWLIST or any(fnmatch.fnmatch(key, p) for p in ENV_ALLOW_PATTERNS):
            env[key] = value
    env.update(
        ADB_RUN_ID=run_id,
        ADB_RUN_DIR=run_dir,
        ADB_SEED=str(seed),
    )
    return env


class RunResult:
    def __init__(self, run_id: str, phase: str, summary: dict, usage: dict, duration_s: float):
        self.run_id = run_id
        self.phase = phase
        self.summary = summary
        self.usage = usage
        self.duration_s = duration_s


def execute_run(
    *,
    program: str,
    manifest: dict,
    spec_params: dict,
    realized_params: dict,
    condition_id: str,
    source: str,
    fetch_ref: str | None = None,
    seed: int,
    replicate: int,
    store: RunStore,
    run_id: str | None = None,
    on_event=None,
) -> RunResult:
    run_id = run_id or ulid()
    # `source` is the per-experiment content identity (feeds condition_id); `fetch_ref` is
    # the fetchable repo rev, recorded for reproducibility and the dirty/deposit gate
    # (docs/plan/specs/condition-hash.md). Callers that pass only `source` (older tests) get
    # fetch_ref = source, preserving the previous dirty behavior.
    fetch_ref = fetch_ref if fetch_ref is not None else source
    dirty = fetch_ref.startswith("dirty:")
    start = time.monotonic()
    seq = 0
    metrics: dict[str, object] = {}
    usage = {"input_tokens": 0, "output_tokens": 0, "llm_calls": 0}
    events_q: queue.Queue = queue.Queue()

    def emit(payload: dict) -> None:
        # transport envelope (runner-owned); the payload is stored verbatim, so
        # payload keys can never collide with envelope keys. Envelope ts is capture
        # time — an experiment's own timestamps ride inside the payload.
        nonlocal seq
        envelope = {"v": 0, "ts": _now(), "run": run_id, "seq": seq, "event": payload}
        seq += 1
        store.write_event(envelope)
        ptype = payload.get("type")
        if ptype == "metric" and "name" in payload:
            metrics[payload["name"]] = payload.get("value")
        elif ptype == "llm.call":
            u = payload.get("usage") or {}
            usage["input_tokens"] += u.get("input_tokens") or 0
            usage["output_tokens"] += u.get("output_tokens") or 0
            usage["llm_calls"] += 1
        if on_event:
            on_event(envelope)

    run_meta = {
        "run": run_id,
        "condition": condition_id,
        "experiment": manifest["name"],
        "source": source,
        "fetch_ref": fetch_ref,
        "dirty": dirty,
        "seed": seed,
        "replicate": replicate,
        "phase": "provisioning",
        "started_at": _now(),
    }
    store.write_run_json(run_meta)

    emit({
        "type": "run.start",
        "condition": condition_id,
        "experiment": manifest["name"],
        "source": source,
        "fetch_ref": fetch_ref,
        "dirty": dirty,
        "spec_params": spec_params,
        "realized_params": realized_params,
        "seed": seed,
        "replicate": replicate,
        "env": {
            "adb_runner": __version__,
            "platform": os.uname().sysname.lower() + "-" + os.uname().machine,
        },
    })

    # resolve stored credentials/endpoints for the providers this run's model ids
    # reference (specs/comparability.md: endpoint + key are environment, not condition)
    provider_env = providers.env_for_run(manifest, realized_params)
    proc = subprocess.Popen(
        [program],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=store.workspace,
        env=child_env(run_id, str(store.dir), seed, provider_env),
        text=True,
    )
    run_meta["phase"] = "running"
    store.write_run_json(run_meta)
    emit({"type": "run.status", "phase": "running"})

    def read_stdout():
        for line in proc.stdout:
            line = line.rstrip("\n")
            if not line.strip():
                continue
            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                payload = None
            if isinstance(payload, dict):
                # a payload, typed or not — `type` is optional (conformance ladder)
                events_q.put(payload)
            else:
                # captured verbatim, untruncated, no invented severity (specs/events.md)
                events_q.put({"type": "stdout", "line": line})
        events_q.put(None)

    def read_stderr():
        for line in proc.stderr:
            line = line.rstrip("\n")
            if line:
                events_q.put({"type": "stderr", "line": line})
        events_q.put(None)

    threads = [threading.Thread(target=t, daemon=True) for t in (read_stdout, read_stderr)]
    for t in threads:
        t.start()

    try:
        proc.stdin.write(json.dumps(realized_params))
        proc.stdin.close()
    except BrokenPipeError:
        pass

    interrupted = False
    finished_readers = 0
    last_beat = time.monotonic()
    child_exited_at: float | None = None
    while finished_readers < 2:
        if time.monotonic() - last_beat >= HEARTBEAT_S:
            os.utime(store.dir / "run.json")
            last_beat = time.monotonic()
        if child_exited_at is None and proc.poll() is not None:
            child_exited_at = time.monotonic()
        try:
            item = events_q.get(timeout=0.5)
        except queue.Empty:
            # orphaned grandchildren can inherit our pipes and hold them open long
            # after the experiment exited — don't wait on them forever
            if child_exited_at is not None and time.monotonic() - child_exited_at > 10:
                emit({"type": "log", "level": "warn",
                      "message": "experiment exited but descendants still hold its "
                                 "stdio pipes; closing the stream (orphans keep "
                                 "running unsupervised)"})
                break
            continue
        except KeyboardInterrupt:
            interrupted = True
            proc.send_signal(signal.SIGTERM)
            continue
        if item is None:
            finished_readers += 1
            continue
        # Ingestion lint (degraded-but-correct, specs/events.md conformance ladder):
        # the payload is ALWAYS stored verbatim — a claimed lifecycle type (`run.*`
        # is runner-synthesized) or a known type with the wrong shape earns a
        # companion warning, never mutation or drop. Schema: events_schema.py.
        ptype = item.get("type")
        if isinstance(ptype, str) and ptype.startswith("run."):
            emit({"type": "log", "level": "warn",
                  "message": f"experiment emitted reserved lifecycle type {ptype!r}; "
                             "preserved verbatim but ignored for run lifecycle"})
        else:
            problems = validate_event(item)
            if problems:
                emit({"type": "log", "level": "warn",
                      "message": f"malformed {ptype} event ({'; '.join(problems[:3])}): "
                                 f"{json.dumps(item)[:300]}"})
        emit(item)

    returncode = proc.wait()
    duration = time.monotonic() - start
    if interrupted or returncode < 0:
        phase = "interrupted"
    elif returncode == 0:
        phase = "completed"
    else:
        phase = "failed"

    # NOTE: no views are materialized or deposited — chat/llm-call projections are
    # rendered from the stream on demand (deposit irreducibles, never derivables;
    # specs/events.md "Standard conversation views")

    summary = {
        name: metrics[name] for name in (manifest.get("results") or {}) if name in metrics
    }
    emit({
        "type": "run.end",
        "phase": phase,
        "duration_s": round(duration, 3),
        "summary": summary,
        "usage_totals": usage,
        "exit_code": returncode,
    })
    run_meta.update(
        phase=phase,
        finished_at=_now(),
        duration_s=round(duration, 3),
        summary=summary,
        usage_totals=usage,
        realized_params=realized_params,
    )
    store.write_run_json(run_meta)
    store.close()
    return RunResult(run_id, phase, summary, usage, duration)
