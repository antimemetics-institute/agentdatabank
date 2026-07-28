"""adb-inspect-eval: run an Inspect eval and translate its log into ADB events.

    adb-inspect-eval CONFIG.json

One run = one `inspect_ai.eval(...)` over one task. The adapter merges $ADB_SEED
into the params and hands us this config; we resolve the task, run the eval into a
private log dir, translate the EvalLog (translate.py), and deposit the raw `.eval`
log as an artifact. A plain program: no ADB imports; failure at any stage is data —
the run finishes with a zeroed summary and exit 0, never crashes.
"""

from __future__ import annotations

import argparse
import contextlib
import io
import shutil
import sys
import threading
import traceback
from pathlib import Path

import yaml

from adb_events.emit import artifact, emit_raw, log, metric, set_output, status
from .models import Params
from .translate import (emit_aggregate, emit_live_model_event, emit_provenance,
                        emit_sample)

_ZERO = {"status": "error", "samples": 0, "completed": 0, "errors": 0,
         "score": 0.0, "score_name": "", "tokens_input": 0, "tokens_output": 0}


def resolve_task(spec: str):
    """`pkg:<module>:<attr>` -> the imported @task callable (how a family selects a
    task function from an installed package, e.g. `pkg:impossiblebench:impossible_swebench`);
    anything else (registry id or `path/file.py@task_fn`) passes through to Inspect
    verbatim."""
    if spec.startswith("pkg:"):
        modname, sep, attr = spec[4:].partition(":")
        if not sep or not modname or not attr:
            raise ValueError(f"pkg: task spec must be pkg:<module>:<attr>, got {spec!r}")
        import importlib
        return getattr(importlib.import_module(modname), attr)
    return spec


def eval_kwargs(params: Params, log_dir: Path) -> dict:
    kw: dict = {
        "model": params.model,
        "task_args": params.task_args,
        "model_args": params.model_args,
        "log_dir": str(log_dir),
        "log_format": "eval",
        "display": "none",
        "seed": params.seed,
    }
    if params.limit:
        kw["limit"] = params.limit
    if params.epochs != 1:
        kw["epochs"] = params.epochs
    if params.max_connections:
        kw["max_connections"] = params.max_connections
    if params.message_limit:
        kw["message_limit"] = params.message_limit
    if params.token_limit:
        kw["token_limit"] = params.token_limit
    # generation config (temperature, max_tokens, reasoning_effort, …) as top-level
    # GenerateConfigArgs kwargs; scoped to generation keys by the caller
    kw.update(params.generate_args)
    return kw


def deposit_log(log_obj, run_dir: Path) -> None:
    """Copy the run's `.eval` log into the deposit as an artifact (the irreducible
    Inspect record; the translated events are its secondary rendering)."""
    src = getattr(log_obj, "location", None)
    if not src or not Path(src).exists():
        return
    dest_dir = run_dir / "artifacts"
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / "run.eval"
    shutil.copyfile(src, dest)
    artifact(name="run.eval", path="artifacts/run.eval",
             media_type="application/octet-stream", size=dest.stat().st_size)


class PrintStream(io.TextIOBase):
    """Solver prints, captured at the source and re-emitted as `stdout` events.

    Inspect runs samples concurrently in one process, so raw prints interleave
    unattributably; capturing at print time lets us read inspect's active-sample
    contextvar and tag each line with the sample that printed it. (The runner
    normally synthesizes `stdout` events itself — this emits the same type one
    hop earlier, where the attribution still exists; anything that escapes this
    capture still becomes a runner-synthesized line.) Side benefit: prints never
    share the JSONL channel with events, so they can't tear an event line."""

    def __init__(self) -> None:
        self._buf = ""
        self._lock = threading.Lock()

    def writable(self) -> bool:  # pragma: no cover - io plumbing
        return True

    def write(self, s: str) -> int:
        with self._lock:
            self._buf += s
            while "\n" in self._buf:
                line, self._buf = self._buf.split("\n", 1)
                if line.strip():
                    emit_raw("stdout", line=line, **self._sample_tag())
        return len(s)

    @staticmethod
    def _sample_tag() -> dict:
        try:
            from inspect_ai.log._samples import sample_active  # internal, pinned
            active = sample_active()
            if active is not None:
                return {"sample_id": active.sample.id, "epoch": active.epoch}
        except Exception:
            pass
        return {}


def run(params: Params) -> None:
    run_dir = Path(__import__("os").environ.get("ADB_RUN_DIR", "."))
    work = Path.cwd()
    log_dir = work / "inspect-logs"

    # imported lazily so a config/param error reports cleanly before the heavy
    # numpy/inspect_ai import chain runs
    from inspect_ai import eval as run_eval
    from inspect_ai.hooks import Hooks, hooks

    agent = params.model
    streamed: set = set()
    # per-sample live-stream state, keyed by inspect's sample execution uuid:
    # the problem identity (id/epoch) plus the message/event ids already emitted
    live: dict = {}

    # STREAM: run_eval blocks through the whole eval, so emit as it goes — a status
    # when each sample starts, its chat turns + llm.call after every completed model
    # call (SampleEvent hook), and a reconciliation pass at sample end for whatever
    # the live path didn't cover (scores, non-model turns). Every streamed event is
    # tagged sample_id/epoch: one eval works through many problems, sequentially or
    # in parallel, and untagged events are unattributable under interleaving.
    @hooks(name="adb-stream", description="stream ADB events as the eval runs")
    class _Stream(Hooks):  # noqa: N801
        async def on_sample_start(self, data) -> None:  # type: ignore[no-untyped-def]
            s = data.summary
            live[data.sample_id] = {"id": s.id, "epoch": s.epoch,
                                    "msgs": set(), "evs": set()}
            status(f"sample {s.id} epoch {s.epoch}: running")

        async def on_sample_event(self, data) -> None:  # type: ignore[no-untyped-def]
            st = live.get(data.sample_id)
            ev = data.event
            if (st is None or type(ev).__name__ != "ModelEvent"
                    or getattr(ev, "pending", None) or ev.output is None):
                return
            uid = getattr(ev, "uuid", None)
            if uid is None or uid in st["evs"]:
                return
            try:
                emit_live_model_event(ev, agent, st["id"], st["epoch"], st["msgs"])
                st["evs"].add(uid)
            except Exception as exc:  # a bad event must not kill the eval
                log(f"stream: live emit failed: {exc}", level="warn")

        async def on_sample_end(self, data) -> None:  # type: ignore[no-untyped-def]
            if data.sample is None:
                return
            st = live.pop(data.sample_id, None) or {"msgs": set(), "evs": set()}
            try:
                emit_sample(data.sample, agent,
                            seen_messages=st["msgs"], seen_events=st["evs"])
                streamed.add(data.sample.uuid)
            except Exception as exc:  # a bad sample must not kill the eval
                log(f"stream: sample emit failed: {exc}", level="warn")

    task = resolve_task(params.task)
    status(f"running inspect eval: task={params.task} model={params.model}")
    # events keep flowing to the real stdout (the JSONL channel); everything the
    # eval prints is captured and re-emitted as tagged `stdout` events (PrintStream)
    set_output(sys.stdout)
    try:
        with contextlib.redirect_stdout(PrintStream()):
            logs = run_eval(task, **eval_kwargs(params, log_dir))
    except Exception as exc:  # an eval that won't even start is data, not a crash
        log(f"inspect eval failed to run: {exc}", level="error")
        _emit_zero()
        return
    finally:
        set_output(None)

    if not logs:
        log("inspect eval produced no log", level="error")
        _emit_zero()
        return

    log_obj = logs[0]
    emit_provenance(log_obj, agent)
    # fallback: emit any sample the hook didn't stream (hook disabled / raced)
    for sample in log_obj.samples or []:
        if getattr(sample, "uuid", None) not in streamed:
            emit_sample(sample, agent)
    summary = emit_aggregate(log_obj, agent)
    deposit_log(log_obj, run_dir)
    if log_obj.error:
        log(f"eval error: {log_obj.error.message}", level="error")
    status(f"done: status={summary['status']} score={summary['score']} "
           f"({summary['completed']}/{summary['samples']} samples)")


def _emit_zero() -> None:
    for k, v in _ZERO.items():
        metric(name=k, value=v)
    status("done: status=error (eval did not run)")


def main() -> int:
    # the task's own prints (solver progress etc.) must not sit in a block buffer
    # until the next event flush pushes them out — the runner reads this pipe live
    try:
        sys.stdout.reconfigure(line_buffering=True)
    except Exception:
        pass
    parser = argparse.ArgumentParser(prog="adb-inspect-eval", description=__doc__)
    parser.add_argument("config", help="path to a JSON (or YAML) config file")
    args = parser.parse_args()
    try:
        params = Params.model_validate(yaml.safe_load(Path(args.config).read_text()))
    except Exception:
        traceback.print_exc()
        return 1
    try:
        run(params)
    except Exception:
        traceback.print_exc()
        _emit_zero()
    return 0


if __name__ == "__main__":
    sys.exit(main())
