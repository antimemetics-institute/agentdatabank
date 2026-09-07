"""The runner protocol: spawn the experiment, feed params, envelope + persist events.

runner → experiment: realized params JSON on stdin; ADB_RUN_ID/ADB_RUN_DIR/ADB_SEED env;
fresh workspace as cwd; a small env allowlist (never the full host environment).
experiment → runner: event payloads as JSON objects on stdout, one per line — each is
wrapped verbatim in the transport envelope {v, ts, run, seq, event} (docs/book/src/reference/events.md);
`type` is optional (conformance ladder: unknown or absent types are preserved). Non-JSON
stdout lines become `stdout` events, stderr lines `stderr` events. Exit code 0 → completed, nonzero → failed, signal → interrupted.
"""

from __future__ import annotations

import datetime
import json
import os
import queue
import signal
import subprocess
import threading
import time
from collections.abc import Callable
from typing import Any, Literal

from . import __version__
from . import credentials

from adb_events import Json, validate_event
from .schema import Manifest, Params
from .store import RunStore
from .ulid import ulid

# DOCKER_HOST: sandboxed experiments must find the machine's docker daemon (a
# per-user rootless socket on dev boxes — see `task docker:up`); like model
# endpoints, where the daemon lives is environment, never condition identity.
# Nothing else ambient — credentials/endpoints reach a run ONLY through the
# credential store (docs/book/src/running/secrets.md), so a stray key exported in the
# shell can neither leak into a run nor shadow the stored value.
ENV_ALLOWLIST = ["PATH", "HOME", "LANG", "LC_ALL", "TERM", "TMPDIR", "DOCKER_HOST"]

# Liveness heartbeat: while the experiment runs, the runner touches run.json's mtime
# (content unchanged — no deposit churn, nothing in the event stream; liveness is
# operational state, not experimental data). Consumers: running + stale mtime =
# crashed ("interrupted?" per docs/book/src/reference/layout.md); experiments never know it exists.
HEARTBEAT_S = 10.0


def _now() -> str:
    return (
        datetime.datetime.now(datetime.timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def child_env(run_id: str, run_dir: str, seed: int,
              credential_env: dict[str, str] | None = None) -> dict[str, str]:
    # constructed from scratch: system basics from the allowlist, then the stored
    # credentials/endpoints (credentials.py) — the store always wins over the
    # host — then ADB_* run vars. This is how a real model reaches its key without
    # the key ever appearing on the command line or being readable from the shell.
    env = {key: value for key, value in os.environ.items() if key in ENV_ALLOWLIST}
    env.update(credential_env or {})
    env.update(
        ADB_RUN_ID=run_id,
        ADB_RUN_DIR=run_dir,
        ADB_SEED=str(seed),
    )
    return env


RunState = Literal["provisioning", "running", "completed", "failed", "interrupted"]


class RunResult:
    def __init__(self, run_id: str, state: RunState, summary: dict[str, Any],
                 usage: dict[str, int], duration_s: float):
        self.run_id = run_id
        self.state = state
        self.summary = summary
        self.usage = usage
        self.duration_s = duration_s


def execute_run(
    *,
    program: str,
    manifest: Manifest,
    spec_params: Params,
    realized_params: Params,
    condition_id: str,
    source: str,
    fetch_ref: str | None = None,
    seed: int,
    replicate: int,
    store: RunStore,
    run_id: str | None = None,
    on_event: Callable[[dict[str, Any]], None] | None = None,
    credential_env: dict[str, str] | None = None,
) -> RunResult:
    run_id = run_id or ulid()
    # `source` is the per-experiment content identity (feeds condition_id); `fetch_ref` is
    # the source reference, recorded for reproduction and dirty-checkout detection
    # (docs/book/src/running/model.md). Callers that pass only `source` (older tests) get
    # fetch_ref = source, preserving the previous dirty behavior.
    fetch_ref = fetch_ref if fetch_ref is not None else source
    dirty = fetch_ref.startswith("dirty:")
    start = time.monotonic()
    seq = 0
    metrics: dict[str, Any] = {}
    usage = {"input_tokens": 0, "output_tokens": 0, "llm_calls": 0}
    events_q: queue.Queue[dict[str, Any] | None] = queue.Queue()

    def emit(payload: dict[str, Any]) -> None:
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
            u: dict[str, Any] = payload.get("usage") or {}
            usage["input_tokens"] += u.get("input_tokens") or 0
            usage["output_tokens"] += u.get("output_tokens") or 0
            usage["llm_calls"] += 1
        if on_event:
            on_event(envelope)

    run_meta: dict[str, Any] = {
        "run": run_id,
        "condition": condition_id,
        "experiment": manifest["name"],
        "source": source,
        "fetch_ref": fetch_ref,
        "dirty": dirty,
        "seed": seed,
        "replicate": replicate,
        "state": "provisioning",
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

    # stored credentials/endpoints for the credential sets this run's model ids route
    # to (docs/book/src/running/model.md: endpoint + key are environment, not condition).
    # The CLI resolves these up front (profile ladder, may prompt) and passes them in;
    # direct callers without one get the default-profile resolution.
    if credential_env is None:
        credential_env = credentials.env_for_run(manifest, realized_params)
    proc = subprocess.Popen(
        [program],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=store.workspace,
        env=child_env(run_id, str(store.dir), seed, credential_env),
        text=True,
    )
    stdin, stdout, stderr = proc.stdin, proc.stdout, proc.stderr
    if stdin is None or stdout is None or stderr is None:
        raise RuntimeError("child pipes missing")  # typeshed can't see Popen(PIPE)
    run_meta["state"] = "running"
    store.write_run_json(run_meta)
    emit({"type": "run.status", "state": "running"})

    def read_stdout() -> None:
        for line in stdout:
            line = line.rstrip("\n")
            if not line.strip():
                continue
            try:
                payload: Json = json.loads(line)
            except json.JSONDecodeError:
                payload = None
            if isinstance(payload, dict):
                # a payload, typed or not — `type` is optional (conformance ladder)
                events_q.put(payload)
            else:
                # captured verbatim, untruncated, no invented severity (docs/book/src/reference/events.md)
                events_q.put({"type": "stdout", "line": line})
        events_q.put(None)

    def read_stderr() -> None:
        for line in stderr:
            line = line.rstrip("\n")
            if line:
                events_q.put({"type": "stderr", "line": line})
        events_q.put(None)

    threads = [threading.Thread(target=t, daemon=True) for t in (read_stdout, read_stderr)]
    for t in threads:
        t.start()

    try:
        stdin.write(json.dumps(realized_params))
        stdin.close()
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
        # Ingestion lint (docs/book/src/reference/events.md):
        # the payload is ALWAYS stored verbatim — a claimed lifecycle type (`run.*`
        # is runner-synthesized) or a known type with the wrong shape earns a
        # companion warning, never mutation or drop. Schema: the adb_events models.
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
    state: RunState
    if interrupted or returncode < 0:
        state = "interrupted"
    elif returncode == 0:
        state = "completed"
    else:
        state = "failed"

    # NOTE: no views are materialized or deposited — chat/llm-call projections are
    # rendered from the stream on demand (deposit irreducibles, never derivables;
    # docs/book/src/reference/events.md#transport)

    results: dict[str, Any] = manifest.get("results") or {}
    summary = {name: metrics[name] for name in results if name in metrics}
    emit({
        "type": "run.end",
        "state": state,
        "duration_s": round(duration, 3),
        "summary": summary,
        "usage_totals": usage,
        "exit_code": returncode,
    })
    run_meta.update(
        state=state,
        finished_at=_now(),
        duration_s=round(duration, 3),
        summary=summary,
        usage_totals=usage,
        realized_params=realized_params,
    )
    store.write_run_json(run_meta)
    store.close()
    return RunResult(run_id, state, summary, usage, duration)
