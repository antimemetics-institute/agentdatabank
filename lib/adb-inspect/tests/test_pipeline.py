"""End-to-end: a real keyless mockllm eval through eval -> translate -> summary.

Skipped where inspect_ai can't import (e.g. a bare venv missing the C++ runtime the
numpy wheel needs) — the nix build and devshell provide it; these assert the real
Inspect objects still map the way test_translate's fakes assume.
"""

from __future__ import annotations

import json
import shutil
import subprocess

import pytest


@pytest.fixture(scope="module")
def inspect_ok():
    try:
        import inspect_ai  # noqa: F401
    except Exception as exc:  # ImportError, or OSError from the numpy wheel
        pytest.skip(f"inspect_ai unavailable: {exc}")


def _hello_task():
    """The same deterministic task experiments/inspect_evals ships as inspect-hello:
    instruction-following samples whose targets are also substrings of mockllm's
    fixed reply ("Default output from mockllm/model"), so the mock scores 1.0
    keyless and offline."""
    from inspect_ai import Task
    from inspect_ai.dataset import MemoryDataset, Sample
    from inspect_ai.scorer import includes
    from inspect_ai.solver import generate

    return Task(
        dataset=MemoryDataset([
            Sample(input='Include the word "model" somewhere in your reply.',
                   target="model"),
            Sample(input='Include the word "output" somewhere in your reply.',
                   target="output"),
        ]),
        solver=generate(),
        scorer=includes(),
    )


def _run_hello(tmp_path):
    from inspect_ai import eval as run_eval

    logs = run_eval(_hello_task(), model="mockllm/model",
                    limit=2, log_dir=str(tmp_path / "logs"), display="none",
                    log_format="eval", seed=7)
    return logs[0]


def test_resolve_task_pkg_form_imports_the_callable():
    from adb_inspect.main import resolve_task

    import math
    assert resolve_task("pkg:math:floor") is math.floor
    assert resolve_task("inspect_evals/gsm8k") == "inspect_evals/gsm8k"  # passthrough
    with pytest.raises(ValueError):
        resolve_task("pkg:no-attr-given")


def test_mock_eval_summary(inspect_ok, tmp_path, capsys):
    from adb_inspect.translate import emit_all

    log = _run_hello(tmp_path)
    assert log.status == "success"
    summary = emit_all(log, "mockllm/model")
    assert summary["status"] == "success"
    assert summary["samples"] == 2 and summary["completed"] == 2
    assert summary["score"] == 1.0
    assert summary["score_name"] == "includes/accuracy"
    assert summary["tokens_output"] > 0


def test_provenance_emitted_from_real_log(inspect_ok, tmp_path, capsys):
    from adb_inspect.translate import emit_all
    emit_all(_run_hello(tmp_path), "mockllm/model")
    events = [json.loads(l) for l in capsys.readouterr().out.splitlines() if l.strip()]
    prov = [e for e in events
            if e["type"] == "agent.event" and e["kind"] == "provenance"]
    assert len(prov) == 1
    # inspect_ai always reports its own version in the log's packages
    assert "inspect_ai" in prov[0]["data"]["packages"]


def test_llm_call_shape(inspect_ok, tmp_path, capsys):
    """llm.call carries the events.md-required fields (regression guard: the raw
    provider payload — OpenAI Responses shape for reasoning models — must NOT be the
    top-level request/response, which lacked request.messages/response.message and
    the runner linted as malformed). Runs in a bare venv, unlike the adb-emit check."""
    from adb_inspect.translate import emit_all
    emit_all(_run_hello(tmp_path), "mockllm/model")
    events = [json.loads(l) for l in capsys.readouterr().out.splitlines() if l.strip()]
    calls = [e for e in events if e["type"] == "llm.call"]
    assert calls, "expected at least one llm.call"
    for c in calls:
        assert isinstance(c["request"]["messages"], list)   # required by events.md
        assert "params" in c["request"]
        assert c["response"] is None or "message" in c["response"]


def test_print_stream_buffers_lines(capsys):
    """PrintStream re-emits complete lines as stdout events (partial writes buffer)."""
    from adb_inspect.main import PrintStream

    ps = PrintStream()
    ps.write("a\nb")
    ps.write("c\n")
    events = [json.loads(l) for l in capsys.readouterr().out.splitlines() if l.strip()]
    assert [(e["type"], e["line"]) for e in events] == [("stdout", "a"), ("stdout", "bc")]


def test_print_capture_tags_the_printing_sample(inspect_ok, tmp_path, capsys):
    """A print() from inside a running sample becomes a stdout event tagged with
    that sample — inspect's active-sample contextvar, read at write time."""
    import contextlib
    import sys

    from adb_events.emit import set_output
    from adb_inspect.main import PrintStream
    from inspect_ai import Task
    from inspect_ai import eval as run_eval
    from inspect_ai.dataset import MemoryDataset, Sample
    from inspect_ai.scorer import includes
    from inspect_ai.solver import solver

    @solver
    def printer():
        async def solve(state, generate):
            print(f"solving {state.sample_id}")
            return await generate(state)
        return solve

    task = Task(dataset=MemoryDataset([Sample(input="say model", target="model", id="p1")]),
                solver=printer(), scorer=includes())
    set_output(sys.stdout)
    try:
        with contextlib.redirect_stdout(PrintStream()):
            run_eval(task, model="mockllm/model", log_dir=str(tmp_path / "logs"),
                     display="none", log_format="eval", seed=7)
    finally:
        set_output(None)
    events = [json.loads(l) for l in capsys.readouterr().out.splitlines() if l.strip()]
    tagged = [e for e in events if e.get("type") == "stdout" and e.get("line") == "solving p1"]
    assert tagged, f"no tagged stdout event in {events!r}"
    assert tagged[0]["meta"] == {"instance_id": "p1", "repeat": 1}


def test_score_reproducible(inspect_ok, tmp_path):
    from adb_inspect.translate import emit_all
    a = emit_all(_run_hello(tmp_path / "a"), "m")
    b = emit_all(_run_hello(tmp_path / "b"), "m")
    # latency varies run to run; the graded outcome must not
    for k in ("status", "samples", "completed", "score", "score_name"):
        assert a[k] == b[k]


def test_events_conform_to_schema(inspect_ok, tmp_path, capsys):
    """Every emitted event validates against `adb-emit schema` (skip if adb-emit
    isn't on PATH — it ships with adb-runner, present in the devshell)."""
    if not shutil.which("adb-emit"):
        pytest.skip("adb-emit not on PATH")
    import jsonschema  # inspect_ai pulls this in

    schema = json.loads(subprocess.check_output(["adb-emit", "schema"], text=True))
    from adb_inspect.translate import emit_all

    emit_all(_run_hello(tmp_path), "mockllm/model")
    events = [json.loads(l) for l in capsys.readouterr().out.splitlines() if l.strip()]
    assert events
    for ev in events:
        jsonschema.validate(ev, schema)
