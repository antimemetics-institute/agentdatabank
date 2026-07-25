"""Translator tests over fake EvalLog objects — duck-typed, no inspect_ai import.

translate.py reads its inputs by attribute and by `type(e).__name__ == 'ModelEvent'`,
so lightweight fakes exercise the whole mapping deterministically and fast.
"""

from __future__ import annotations

import json
from types import SimpleNamespace as NS

from adb_inspect import translate


def _dumpable(d):
    """A fake pydantic-ish object whose model_dump(mode=...) returns d."""
    return NS(model_dump=lambda mode=None, _d=d: _d)


class ModelEvent:  # name matters: translate filters on type(e).__name__
    def __init__(self, model, call, usage, msg, stop, inp, config=None,
                 working_time=0.05, error=None):
        self.model = model
        self.call = call
        self.input = inp                 # message list as sent
        self.config = config or _dumpable({"max_tokens": 1024})
        self.working_time = working_time
        self.error = error
        self.output = NS(usage=usage, message=msg, stop_reason=stop)


def _msg(role, text):
    return NS(role=role, text=text)


def _score(value, answer="a"):
    return NS(value=value, answer=answer)


def _call(req, resp):
    return NS(request=req, response=resp)


def _sample_wire():
    """A sample whose model event carries a raw provider call (kept under response.raw)."""
    return NS(
        id=1, epoch=1, target="default", error=None,
        messages=[_msg("user", "hi"), _msg("assistant", "Default output")],
        events=[ModelEvent("mockllm/model", _call({"vendor": "wire"}, {"provider": "raw"}),
                           NS(input_tokens=2, output_tokens=33),
                           _dumpable({"role": "assistant", "content": "Default output"}),
                           "stop", inp=[_dumpable({"role": "user", "content": "hi"})])],
        scores={"includes": _score("C")},
    )


def _sample_derived():
    """A sample whose model event has no recorded raw call (no response.raw)."""
    return NS(
        id=2, epoch=1, target="output", error=None,
        messages=[_msg("user", "yo"), _msg("assistant", "output")],
        events=[ModelEvent("mockllm/model", None,
                           NS(input_tokens=1, output_tokens=5),
                           _dumpable({"role": "assistant", "content": "output"}),
                           "stop", inp=[_dumpable({"role": "user", "content": "yo"})])],
        scores={"includes": _score("I")},
    )


def _eval_spec():
    return NS(task="gsm8k", task_version=1, task_registry_name="inspect_evals/gsm8k",
              model="mockllm/model",
              packages={"inspect_ai": "0.3.248", "inspect_evals": "0.15.0"},
              dataset=NS(name="gsm8k", location="hf://openai/gsm8k", samples=2),
              revision=NS(type="git", origin="", commit="911f0ed", dirty=False))


def _log():
    scores = [NS(name="includes",
                 metrics={"accuracy": NS(value=0.5), "stderr": NS(value=0.1)})]
    results = NS(scores=scores, total_samples=2, completed_samples=2)
    stats = NS(model_usage={"mockllm/model": NS(input_tokens=3, output_tokens=38)})
    return NS(status="success", eval=_eval_spec(),
              samples=[_sample_wire(), _sample_derived()],
              results=results, stats=stats)


def _capture(capsys):
    out = capsys.readouterr().out
    return [json.loads(l) for l in out.splitlines() if l.strip()]


def test_full_translation_shape(capsys):
    summary = translate.emit_all(_log(), "mockllm/model")
    events = _capture(capsys)
    kinds = [e["type"] for e in events]

    assert kinds.count("message") == 4  # 2 samples x 2 messages
    assert kinds.count("llm.call") == 2
    ae = [e for e in events if e["type"] == "agent.event"]
    assert [e for e in ae if e["kind"] == "sample"].__len__() == 2
    assert [e for e in ae if e["kind"] == "provenance"].__len__() == 1

    # ADB-shaped request/response (events.md), raw provider payload under response.raw
    calls = [e for e in events if e["type"] == "llm.call"]
    assert calls[0]["request"]["messages"] == [{"role": "user", "content": "hi"}]
    assert calls[0]["request"]["params"] == {"max_tokens": 1024}
    assert calls[0]["response"]["message"] == {"role": "assistant", "content": "Default output"}
    assert calls[0]["response"]["finish_reason"] == "stop"
    assert calls[0]["response"]["raw"] == {"provider": "raw"}  # raw call preserved here
    assert "raw" not in calls[1]["response"]                   # none recorded → absent
    assert calls[0]["usage"] == {"input_tokens": 2, "output_tokens": 33}

    # per-sample scores mapped C/I -> 1.0/0.0
    per = [e["value"] for e in events
           if e["type"] == "metric" and e["name"] == "score:includes"]
    assert per == [1.0, 0.0]

    # aggregate metric surfaced
    assert any(e["type"] == "metric" and e["name"] == "includes/accuracy"
               and e["value"] == 0.5 for e in events)

    assert summary == {"status": "success", "samples": 2, "completed": 2,
                       "errors": 0, "score": 0.5, "score_name": "includes/accuracy",
                       "tokens_input": 3, "tokens_output": 38}


def test_messages_carry_sample_channel_and_meta(capsys):
    translate.emit_all(_log(), "m")
    msgs = [e for e in _capture(capsys) if e["type"] == "message"]
    assert {m["channel"] for m in msgs} == {"sample:1", "sample:2"}
    assert all(m["meta"]["sample_id"] in (1, 2) for m in msgs)
    assert all(m["from"] in ("user", "assistant") for m in msgs)


def test_llm_calls_tagged_with_sample(capsys):
    translate.emit_all(_log(), "m")
    calls = [e for e in _capture(capsys) if e["type"] == "llm.call"]
    assert [c["meta"]["sample_id"] for c in calls] == [1, 2]
    assert all(c["meta"]["epoch"] == 1 for c in calls)


def _chat(role, text, mid):
    """A fake ChatMessage: id/role/text for the live path, model_dump for _dump."""
    return NS(id=mid, role=role, text=text,
              model_dump=lambda mode=None, _d={"role": role, "content": text}: _d)


def test_live_model_event_streams_new_turns_once(capsys):
    seen: set = set()
    ev = ModelEvent("m", None, NS(input_tokens=1, output_tokens=2),
                    _chat("assistant", "yo", "m2"), "stop",
                    inp=[_chat("user", "hi", "m1")])
    translate.emit_live_model_event(ev, "agent", "s1", 1, seen)
    events = _capture(capsys)
    assert [e["from"] for e in events if e["type"] == "message"] == ["user", "assistant"]
    call = [e for e in events if e["type"] == "llm.call"][0]
    assert call["meta"] == {"sample_id": "s1", "epoch": 1}

    # replaying the same event emits no duplicate turns (deduped via seen ids)
    translate.emit_live_model_event(ev, "agent", "s1", 1, seen)
    assert not [e for e in _capture(capsys) if e["type"] == "message"]


def test_emit_sample_skips_what_was_streamed_live(capsys):
    s = _sample_wire()
    s.messages[0].id = "m-user"
    s.messages[1].id = "m-asst"
    s.events[0].uuid = "ev-1"
    translate.emit_sample(s, "m", seen_messages={"m-user", "m-asst"},
                          seen_events={"ev-1"})
    events = _capture(capsys)
    # only the per-sample score + closing agent.event remain
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
    assert d["dataset"]["name"] == "gsm8k"
    assert d["revision"]["commit"] == "911f0ed"


def test_headline_prefers_accuracy():
    scores = [NS(name="s", metrics={"f1": NS(value=0.9), "accuracy": NS(value=0.2)})]
    log = NS(results=NS(scores=scores))
    assert translate.headline(log) == (0.2, "s/accuracy")


def test_headline_falls_back_to_first_numeric():
    scores = [NS(name="s", metrics={"mean": NS(value=0.7), "note": NS(value="hi")})]
    log = NS(results=NS(scores=scores))
    assert translate.headline(log) == (0.7, "s/mean")


def test_translation_is_pure(capsys):
    translate.emit_all(_log(), "m")
    first = capsys.readouterr().out
    translate.emit_all(_log(), "m")
    second = capsys.readouterr().out
    assert first == second  # translate is a pure function of the log
