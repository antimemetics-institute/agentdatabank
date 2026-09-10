"""The runner protocol: spawn the experiment, feed params, envelope + persist events.

runner → experiment: realized params JSON on stdin; ADB_RUN_ID/ADB_RUN_DIR/ADB_SEED env;
fresh workspace as cwd; a small env allowlist (never the full host environment).
experiment → runner: validated JSON events through ADB_EVENT_SOCKET; stdout and
stderr are always captured as text. The runner records typed envelopes and
acknowledges each socket submission after writing it to the event store.
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
from copy import deepcopy
from typing import Any, Literal, TextIO

from . import __version__
from . import credentials

from adb_events import (
    Envelope,
    CapturedLine,
    Payload,
    Metric,
    LLMCall,
    Log,
    RunStart,
    RunStatus,
    RunEnd,
    RunEnvironment,
    UsageTotals,
)
from .schema import Manifest, Params
from .event_socket import event_socket
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


def child_env(
    run_id: str, run_dir: str, seed: int, credential_env: dict[str, str] | None = None
) -> dict[str, str]:
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
    def __init__(
        self,
        run_id: str,
        state: RunState,
        summary: dict[str, Any],
        usage: dict[str, int],
        duration_s: float,
    ):
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
    result_definitions = deepcopy(manifest.get("results", {}))
    usage = {"input_tokens": 0, "output_tokens": 0, "llm_calls": 0}
    events_q: queue.Queue[CapturedLine | Log | None] = queue.Queue()
    record_lock = threading.Lock()

    def record_payload(payload: Payload) -> None:
        nonlocal seq
        # Socket handlers and stdio capture share one sequence and store writer.
        with record_lock:
            envelope = Envelope(v=0, ts=_now(), run=run_id, seq=seq, event=payload)
            # Serialize the public models, including defaults and wire aliases.
            saved = envelope.model_dump(mode="json", by_alias=True)
            store.write_event(saved)
            seq += 1
            if isinstance(payload, Metric):
                metrics[payload.name] = payload.value
            elif isinstance(payload, LLMCall):
                if payload.usage is not None:
                    usage["input_tokens"] += payload.usage.input_tokens or 0
                    usage["output_tokens"] += payload.usage.output_tokens or 0
                usage["llm_calls"] += 1
            if on_event:
                on_event(saved)

    run_meta: dict[str, Any] = {
        "run": run_id,
        "condition": condition_id,
        "experiment": manifest["name"],
        "result_definitions": result_definitions,
        "source": source,
        "fetch_ref": fetch_ref,
        "dirty": dirty,
        "seed": seed,
        "replicate": replicate,
        "state": "provisioning",
        "started_at": _now(),
    }
    store.write_run_json(run_meta)

    record_payload(
        RunStart(
            result_definitions=result_definitions,
            condition=condition_id,
            experiment=manifest["name"],
            source=source,
            fetch_ref=fetch_ref,
            dirty=dirty,
            spec_params=spec_params,
            realized_params=realized_params,
            seed=seed,
            replicate=replicate,
            env=RunEnvironment(
                adb_runner=__version__,
                platform=os.uname().sysname.lower() + "-" + os.uname().machine,
            ),
        )
    )

    # stored credentials/endpoints for the credential sets this run's model ids route
    # to (docs/book/src/running/model.md: endpoint + key are environment, not condition).
    # The CLI resolves these up front (profile ladder, may prompt) and passes them in;
    # direct callers without one get the default-profile resolution.
    if credential_env is None:
        credential_env = credentials.env_for_run(manifest, realized_params)
    run_meta["state"] = "running"
    store.write_run_json(run_meta)
    record_payload(RunStatus(state="running"))
    with event_socket(record_payload) as socket_path:
        proc = subprocess.Popen(
            [program],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=store.workspace,
            env={
                **child_env(run_id, str(store.dir), seed, credential_env),
                "ADB_EVENT_SOCKET": socket_path,
            },
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        stdin, stdout, stderr = proc.stdin, proc.stdout, proc.stderr
        if stdin is None or stdout is None or stderr is None:
            raise RuntimeError("child pipes missing")  # typeshed can't see Popen(PIPE)

        def read_output(stream: TextIO, kind: Literal["stdout", "stderr"]) -> None:
            try:
                for line in stream:
                    line = line.rstrip("\n")
                    if not line or (kind == "stdout" and not line.strip()):
                        continue
                    events_q.put(CapturedLine(type=kind, line=line))
            except Exception as exc:
                events_q.put(
                    Log(level="error", message=f"failed to capture {kind}: {exc}")
                )
            finally:
                events_q.put(None)

        threads = [
            threading.Thread(target=read_output, args=(stdout, "stdout"), daemon=True),
            threading.Thread(target=read_output, args=(stderr, "stderr"), daemon=True),
        ]
        for t in threads:
            t.start()

        try:
            stdin.write(json.dumps(realized_params))
            stdin.close()
        except BrokenPipeError:
            pass

        interrupted = False
        capture_failed = False
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
                if (
                    child_exited_at is not None
                    and time.monotonic() - child_exited_at > 10
                ):
                    record_payload(
                        Log(
                            level="warn",
                            message="experiment exited but descendants still hold its "
                            "stdio pipes; closing the stream (orphans keep "
                            "running unsupervised)",
                        )
                    )
                    break
                continue
            except KeyboardInterrupt:
                interrupted = True
                proc.send_signal(signal.SIGTERM)
                continue
            if item is None:
                finished_readers += 1
                continue
            if isinstance(item, Log):
                capture_failed = True
            record_payload(item)

        returncode = proc.wait()
    duration = time.monotonic() - start
    state: RunState
    if interrupted or returncode < 0:
        state = "interrupted"
    elif returncode == 0 and not capture_failed:
        state = "completed"
    else:
        state = "failed"

    # NOTE: no views are materialized or deposited — chat/llm-call projections are
    # rendered from the stream on demand (deposit irreducibles, never derivables;
    # docs/book/src/reference/events.md#transport)

    # Declarations describe outputs; every observed metric belongs in the summary,
    # including undeclared metrics. Missing declared outputs stay absent.
    summary = dict(metrics)
    record_payload(
        RunEnd(
            state=state,
            duration_s=round(duration, 3),
            summary=summary,
            usage_totals=UsageTotals.model_validate(usage),
            exit_code=returncode,
        )
    )
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
