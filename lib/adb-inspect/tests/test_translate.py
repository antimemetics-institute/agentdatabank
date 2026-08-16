"""Translator tests over REAL inspect_ai objects.

These used to run on duck-typed fakes; they now construct the actual pydantic
models (EvalLog, EvalSample, ModelEvent, …), so they double as contract tests
against the PINNED inspect_ai version — a field the translator reads that
upstream renames or retypes fails here at test time, not mid-eval. The cost is
that construction states every required field; the fixtures below are the
minimal honest instances.
"""

from __future__ import annotations

import json
from typing import Any

from inspect_ai._util.error import EvalError
from inspect_ai.event import ModelEvent
from inspect_ai.log import EvalLog, EvalSample
from inspect_ai.log._log import (EvalConfig, EvalDataset, EvalMetric, EvalResults,
                                 EvalRevision, EvalScore, EvalSpec, EvalStats)
from inspect_ai.model import (ChatMessageAssistant, ChatMessageUser, GenerateConfig,
                              ModelCall, ModelOutput, ModelUsage)
from inspect_ai.model._model_output import ChatCompletionChoice
from inspect_ai.scorer import Score

from adb_inspect import translate


def _output(text: str, *, mid: str, stop: str = "stop",
            usage: ModelUsage | None = None) -> ModelOutput:
    return ModelOutput(
        model="mockllm/model",
        choices=[ChatCompletionChoice(
            message=ChatMessageAssistant(content=text, id=mid), stop_reason=stop)],
        usage=usage)


def _model_event(*, call: ModelCall | None, usage: ModelUsage | None,
                 reply: str, in_id: str, out_id: str,
                 working_time: float | None = 0.05,
                 error: str | None = None) -> ModelEvent:
    return ModelEvent(
        model="mockllm/model",
        input=[ChatMessageUser(content="hi", id=in_id)],
        tools=[], tool_choice="none",
        config=GenerateConfig(max_tokens=1024),
        output=_output(reply, mid=out_id,
                       stop="unknown" if error else "stop", usage=usage),
        call=call, working_time=working_time, error=error)


def _sample(sid: int, *, call: ModelCall | None, score: str,
            reply: str) -> EvalSample:
    ev = _model_event(call=call, usage=ModelUsage(input_tokens=sid, output_tokens=33),
                      reply=reply, in_id=f"mu-{sid}", out_id=f"ma-{sid}")
    return EvalSample(
        id=sid, epoch=1, input="hi", target="default",
        messages=[ChatMessageUser(content="hi", id=f"mu-{sid}"),
                  ChatMessageAssistant(content=reply, id=f"ma-{sid}")],
        output=_output(reply, mid=f"ma-{sid}"),
        events=[ev],
        scores={"includes": Score(value=score, answer="a")})


def _log() -> EvalLog:
    return EvalLog(
        status="success",
        eval=EvalSpec(
            created="2026-01-01T00:00:00+00:00", task="gsm8k", task_version=1,
            task_id="t", run_id="r", model="mockllm/model", config=EvalConfig(),
            dataset=EvalDataset(name="gsm8k", location="hf://openai/gsm8k", samples=2),
            packages={"inspect_ai": "0.3.248", "inspect_evals": "0.15.0"},
            revision=EvalRevision(type="git", origin="", commit="911f0ed"),
            task_registry_name="inspect_evals/gsm8k"),
        results=EvalResults(
            scores=[EvalScore(name="includes", scorer="includes",
                              metrics={"accuracy": EvalMetric(name="accuracy", value=0.5),
                                       "stderr": EvalMetric(name="stderr", value=0.1)})],
            total_samples=2, completed_samples=2),
        stats=EvalStats(started_at="2026-01-01T00:00:00+00:00",
                        completed_at="2026-01-01T00:01:00+00:00",
                        model_usage={"mockllm/model": ModelUsage(input_tokens=3,
                                                                 output_tokens=38)}),
        samples=[
            _sample(1, call=ModelCall.create({"vendor": "wire"}, {"provider": "raw"}),
                    score="C", reply="Default output"),
            _sample(2, call=None, score="I", reply="output"),
        ])


def _capture(capsys) -> list[dict[str, Any]]:
    out = capsys.readouterr().out
    return [json.loads(line) for line in out.splitlines() if line.strip()]


def _slim(msg: dict[str, Any]) -> tuple[str, str]:
    """(role, content) — real ChatMessage dumps carry ids and bookkeeping fields;
    the invariants under test are placement and content, not the serializer."""
    return msg["role"], msg["content"]


def test_full_translation_shape(capsys):
    summary = translate.emit_all(_log(), "mockllm/model")
    events = _capture(capsys)
    kinds = [e["type"] for e in events]

    assert kinds.count("message") == 4  # 2 samples x 2 messages
    assert kinds.count("llm.call") == 2
    ae = [e for e in events if e["type"] == "agent.event"]
    assert len([e for e in ae if e["kind"] == "instance"]) == 2
    assert len([e for e in ae if e["kind"] == "provenance"]) == 1

    # ADB-shaped request/response (events.md), raw provider payload under response.raw
    calls = [e for e in events if e["type"] == "llm.call"]
    assert [_slim(m) for m in calls[0]["request"]["messages"]] == [("user", "hi")]
    assert calls[0]["request"]["params"] == {"max_tokens": 1024}
    assert _slim(calls[0]["response"]["message"]) == ("assistant", "Default output")
    assert calls[0]["response"]["finish_reason"] == "stop"
    assert calls[0]["response"]["raw"] == {"provider": "raw"}  # raw call preserved here
    assert "raw" not in calls[1]["response"]                   # none recorded → absent
    assert calls[0]["usage"] == {"input_tokens": 1, "output_tokens": 33}

    # per-instance scores ride the instance close-out, NOT metric events (a metric
    # has no instance scope — N same-named metrics buried the run header)
    inst = [e for e in ae if e["kind"] == "instance"]
    assert [e["data"]["scores"] for e in inst] == \
        [{"includes": "C"}, {"includes": "I"}]
    assert [e["data"]["repeat"] for e in inst] == [1, 1]
    assert not [e for e in events
                if e["type"] == "metric" and e["name"].startswith("score:")]

    # aggregate metric surfaced
    assert any(e["type"] == "metric" and e["name"] == "includes/accuracy"
               and e["value"] == 0.5 for e in events)

    assert summary == {"status": "success", "samples": 2, "completed": 2,
                       "errors": 0, "score": 0.5, "score_name": "includes/accuracy",
                       "tokens_input": 3, "tokens_output": 38}


def test_messages_carry_sample_channel_and_meta(capsys):
    translate.emit_all(_log(), "m")
    msgs = [e for e in _capture(capsys) if e["type"] == "message"]
    assert {m["channel"] for m in msgs} == {"instance:1", "instance:2"}
    assert all(m["meta"]["instance_id"] in (1, 2) for m in msgs)
    assert all(m["from"] in ("user", "assistant") for m in msgs)


def test_llm_calls_tagged_with_sample(capsys):
    translate.emit_all(_log(), "m")
    calls = [e for e in _capture(capsys) if e["type"] == "llm.call"]
    assert [c["meta"]["instance_id"] for c in calls] == [1, 2]
    assert all(c["meta"]["repeat"] == 1 for c in calls)


# --- error paths: only ever executed on real provider failure, so the tests are the
# only coverage these branches get before live-fire ---------------------------------

def test_errored_model_event_emits_structured_error(capsys):
    """The live-fire regression: a failed call's ModelEvent carries `error` as a
    plain string, a placeholder empty output message, no usage, no working_time,
    and the provider's error body under call.response (inspect_ai's error branch).
    It must land as the structured {kind, message} wire error — the old code passed
    the bare string, and the first-ever execution of this branch crashed a run."""
    ev = _model_event(
        call=ModelCall.create({"vendor": "wire"}, {"error": "model call failed"}),
        usage=None, reply="", in_id="m1", out_id="m2",
        working_time=None, error="model call failed")
    translate.emit_model_event(ev, "agent", "s1", 1)
    [call] = _capture(capsys)
    assert call["type"] == "llm.call"
    assert call["error"] == {"kind": "model_error", "message": "model call failed"}
    assert call["response"]["raw"] == {"error": "model call failed"}
    assert "usage" not in call
    assert "latency_ms" not in call


def test_sample_error_lands_on_instance_closeout(capsys):
    """sample.error is an EvalError object — its `.message` (not its pydantic
    str()) must land on the instance close-out (wire error is `str | None`)."""
    s = _sample(2, call=None, score="I", reply="output")
    s.error = EvalError(message="RuntimeError('boom')",
                        traceback="", traceback_ansi="")
    translate.emit_sample(s, "m")
    inst = [e for e in _capture(capsys)
            if e["type"] == "agent.event" and e["kind"] == "instance"]
    assert inst[0]["data"]["error"] == "RuntimeError('boom')"


def test_live_model_event_streams_new_turns_once(capsys):
    seen: set[str] = set()
    ev = _model_event(call=None, usage=ModelUsage(input_tokens=1, output_tokens=2),
                      reply="yo", in_id="m1", out_id="m2")
    translate.emit_live_model_event(ev, "agent", "s1", 1, seen)
    events = _capture(capsys)
    assert [e["from"] for e in events if e["type"] == "message"] == ["user", "assistant"]
    call = [e for e in events if e["type"] == "llm.call"][0]
    assert call["meta"] == {"instance_id": "s1", "repeat": 1}

    # replaying the same event emits no duplicate turns (deduped via seen ids)
    translate.emit_live_model_event(ev, "agent", "s1", 1, seen)
    assert not [e for e in _capture(capsys) if e["type"] == "message"]


def test_emit_sample_skips_what_was_streamed_live(capsys):
    s = _sample(1, call=None, score="C", reply="Default output")
    translate.emit_sample(s, "m", seen_messages={"mu-1", "ma-1"},
                          seen_events={s.events[0].uuid or ""})
    events = _capture(capsys)
    # only the closing agent.event remains
    assert not [e for e in events if e["type"] in ("message", "llm.call")]
    assert [e["type"] for e in events if e["type"] == "agent.event"] == ["agent.event"]


def test_provenance_records_sliceable_covariates(capsys):
    translate.emit_all(_log(), "mockllm/model")
    prov = [e for e in _capture(capsys)
            if e["type"] == "agent.event" and e["kind"] == "provenance"]
    assert len(prov) == 1
    d = prov[0]["data"]
    # the exact upstream versions advisories will slice on
    assert d["packages"] == {"inspect_ai": "0.3.248", "inspect_evals": "0.15.0"}
    assert d["task"] == "gsm8k" and d["task_version"] == 1
