"""Every emitter pathway: happy path lands on the wire correctly, and a malformed
payload raises TypeError AT the emit site — the producer-validation guarantee
(docs/plan/events.md). The rejection tests are load-bearing: msgspec Structs do NOT
type-check plain construction, so nothing but the msgspec.convert call in
emit._validated stands between a bad payload and the wire. If a future emitter is
added with direct Struct construction, its rejection test here is what fails.
"""

import io
import json

import msgspec
import pytest

from adb_events import emit, json_schemas, validate_event


@pytest.fixture()
def lines(capsys):
    """Emitted wire lines, parsed."""
    def read():
        out = capsys.readouterr().out
        return [json.loads(line) for line in out.splitlines() if line]
    return read


# --- happy paths -----------------------------------------------------------------

def test_status(lines):
    emit.status("warming up")
    assert lines() == [{"type": "status", "detail": "warming up"}]


def test_log_default_and_explicit_level(lines):
    emit.log("hello")
    emit.log("boom", level="error")
    # omit_defaults drops the default level from the wire
    assert lines() == [
        {"type": "log", "message": "hello"},
        {"type": "log", "message": "boom", "level": "error"},
    ]


def test_metric_scalars(lines):
    emit.metric(name="reward", value=0.5, step=3, unit="frac")
    emit.metric(name="verdict", value="cooperate")
    emit.metric(name="halted", value=True)
    got = lines()
    assert got[0] == {"type": "metric", "name": "reward", "value": 0.5,
                      "step": 3, "unit": "frac"}
    assert got[1] == {"type": "metric", "name": "verdict", "value": "cooperate"}
    assert got[2] == {"type": "metric", "name": "halted", "value": True}


def test_message_from_rename_and_meta(lines):
    emit.message(from_="alice", content="hi", channel="public",
                 to="bob", visible_to=["bob"], round=2)
    [got] = lines()
    assert got["from"] == "alice"          # wire key is `from`, not `from_`
    assert "from_" not in got
    assert got["meta"] == {"round": 2}     # extra kwargs ride in meta


def test_llm_call_nested_shapes(lines):
    emit.llm_call(
        agent="alice", model="openai/qwen3.5-9b",
        request={"messages": [{"role": "user", "content": "hi"}],
                 "params": {"temperature": 0}},
        response={"message": {"role": "assistant", "content": "yo"},
                  "finish_reason": "stop"},
        usage={"input_tokens": 5, "output_tokens": 2},
        latency_ms=12.5,
        instance_id="row-7",
    )
    [got] = lines()
    assert got["type"] == "llm.call"
    assert got["request"]["messages"][0]["role"] == "user"
    assert got["usage"] == {"input_tokens": 5, "output_tokens": 2}
    assert got["meta"] == {"instance_id": "row-7"}


def test_agent_event(lines):
    emit.agent_event(agent="alice", kind="vote", target="bob")
    assert lines() == [{"type": "agent.event", "agent": "alice", "kind": "vote",
                        "data": {"target": "bob"}}]


def test_instance_full(lines):
    emit.instance(agent="solver", id="row-7", repeat=2,
                  scores={"combined_scorer/refusal": 1, "pass": True},
                  error=None, target="42")
    [got] = lines()
    assert got["type"] == "agent.event" and got["kind"] == "instance"
    assert got["data"]["id"] == "row-7"
    assert got["data"]["repeat"] == 2
    assert got["data"]["scores"] == {"combined_scorer/refusal": 1, "pass": True}
    assert got["data"]["target"] == "42"
    assert "error" not in got["data"]      # None omitted, not emitted


def test_instance_int_id_and_minimal(lines):
    emit.instance(agent="solver", id=3)
    [got] = lines()
    assert got["data"] == {"id": 3}


def test_artifact_size_becomes_bytes(lines):
    emit.artifact(name="transcript", path="out/t.json",
                  media_type="application/json", size=123)
    assert lines() == [{"type": "artifact", "name": "transcript",
                        "path": "out/t.json", "media_type": "application/json",
                        "bytes": 123}]


def test_emit_raw_is_unvalidated(lines):
    emit.emit_raw("werewolf.night", victim=None, anything={"nested": [1, {}]})
    assert lines() == [{"type": "werewolf.night", "victim": None,
                        "anything": {"nested": [1, {}]}}]


def test_set_output_redirects_and_restores(lines):
    buf = io.StringIO()
    emit.set_output(buf)
    try:
        emit.status("into the buffer")
    finally:
        emit.set_output(None)
    emit.status("back on stdout")
    assert json.loads(buf.getvalue()) == {"type": "status", "detail": "into the buffer"}
    assert lines() == [{"type": "status", "detail": "back on stdout"}]


# --- rejection paths: malformed payloads must raise, not reach the wire -----------
# Bad values are passed deliberately (annotations are not enforced at call time —
# this is exactly the un-typechecked-caller case the runtime validation exists for).

@pytest.mark.parametrize("call", [
    lambda: emit.status(detail=123),
    lambda: emit.log("x", level="fatal"),                       # not in the Literal
    lambda: emit.metric(name="a", value={"nested": 1}),         # scalar-only
    lambda: emit.metric(name="a", value=[1, 2]),
    lambda: emit.metric(name=123, value=1),
    lambda: emit.message(from_="a", content="hi", channel=7),
    lambda: emit.message(from_="a", content="hi", channel="c", visible_to="bob"),
    lambda: emit.llm_call(agent=None, model="m", request={"messages": "nope"}),
    lambda: emit.llm_call(agent=None, model="m",
                          request={"messages": []}, latency_ms="fast"),
    lambda: emit.llm_call(agent=None, model="m", request={"messages": []},
                          error={"kind": "timeout"}),           # missing message
    lambda: emit.agent_event(agent=7, kind="vote"),
    lambda: emit.artifact(name="a", path="p", size="big"),
])
def test_malformed_payload_raises(call, capsys):
    with pytest.raises(TypeError):
        call()
    assert capsys.readouterr().out == ""   # nothing reached the wire


@pytest.mark.parametrize("call", [
    lambda: emit.instance(agent="s", id=True),                  # bool is not an id
    lambda: emit.instance(agent="s", id=1.5),
    lambda: emit.instance(agent="s", id="x", scores={"s": {"acc": 1}}),
    lambda: emit.instance(agent="s", id="x", scores={"s": [1]}),
])
def test_instance_guards_raise(call, capsys):
    with pytest.raises(TypeError):
        call()
    assert capsys.readouterr().out == ""


# --- ingestion side + schema export ------------------------------------------------

def test_validate_event_pathways():
    assert validate_event({"type": "metric", "name": "a", "value": 1}) == []
    assert validate_event({"type": "metric", "name": "a", "value": {}}) != []
    # unknown/absent types are legal (conformance ladder), unknown fields ignored
    assert validate_event({"type": "werewolf.night", "victim": None}) == []
    assert validate_event({"no": "type"}) == []
    assert validate_event({"type": "status", "detail": "ok", "extra": 1}) == []


def test_json_schemas_cover_all_types():
    schemas = json_schemas()
    assert set(schemas) == {"status", "log", "stdout", "stderr", "metric",
                            "message", "llm.call", "agent.event", "artifact"}


def test_struct_construction_does_not_validate():
    """Documents WHY emitters must go through msgspec.convert: plain construction
    accepts garbage silently. If msgspec ever changes this, we can simplify."""
    from adb_events.models import Metric
    m = Metric(name=123, value={"not": "scalar"})   # no error — that's the trap
    assert m.name == 123
