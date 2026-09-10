"""Author constructors, lossless metadata, and permissive ingestion contracts."""

import json
from concurrent.futures import ThreadPoolExecutor
from typing import Literal

import pytest
from pydantic import BaseModel, ValidationError
from pydantic_core import PydanticSerializationError

from adb_events import (
    AgentEvent,
    Artifact,
    CapturedLine,
    CustomEvent,
    RunStatus,
    Instance,
    InstanceData,
    LLMCall,
    LLMError,
    LLMRequest,
    LLMResponse,
    LLMUsage,
    Log,
    Message,
    Metric,
    Status,
    emit,
    json_schemas,
    validate_event,
)


def test_models_emit_wire_shapes(event_capture):
    emit(Status(detail="warming up"))
    emit(Log(message="hello"))
    emit(Message(from_="alice", content="hi", channel="world", meta={"round": 2}))
    emit(Artifact(name="log", path="artifacts/log", bytes=123))
    events = event_capture.read()
    assert events[0] == {"type": "status", "detail": "warming up"}
    assert events[1] == {"type": "log", "message": "hello", "level": "info"}
    assert events[2] == {
        "type": "message",
        "from": "alice",
        "content": "hi",
        "channel": "world",
        "meta": {"round": 2},
        "to": None,
        "visible_to": None,
    }
    assert events[3]["bytes"] == 123
    assert all(validate_event(e) == [] for e in events)


def test_nested_provider_metadata_survives(event_capture):
    raw = {"system_fingerprint": "fp_123", "vendor": {"future": [1, None, True]}}
    emit(
        LLMCall(
            agent="alice",
            model="provider/alias",
            request=LLMRequest(
                messages=[{"role": "user", "content": "hi"}],
                params={"temperature": 0.2},
                model="sent-model",
                raw={"vendor_request": {"custom": 1}},
            ),
            response=LLMResponse(
                message={"role": "assistant", "tool_calls": []},
                model="resolved-model",
                raw=raw,
            ),
            usage=LLMUsage(input_tokens=0, output_tokens=2),
            latency_ms=0,
        )
    )
    event = event_capture.read()[0]
    assert event["response"]["raw"] == raw
    assert event["request"]["raw"] == {"vendor_request": {"custom": 1}}
    assert event["request"]["model"] == "sent-model"
    assert event["response"]["model"] == "resolved-model"
    assert event["usage"]["input_tokens"] == event["latency_ms"] == 0


@pytest.mark.parametrize(
    "construct",
    [
        lambda: Status(detail=123),
        lambda: Status(detail="ok", detial="typo"),
        lambda: Log(message="x", level="fatal"),
        lambda: Metric(name="n", value={"nested": 1}),
        lambda: Metric(name="n", value=float("nan")),
        lambda: Message(from_="a", content="hi", channel=7),
        lambda: LLMRequest(messages="nope"),
        lambda: LLMRequest(messages=[], prams={}),
        lambda: LLMResponse(message={}, system_fingerprint="misplaced"),
        lambda: LLMUsage(input_tokens=-1),
        lambda: LLMUsage(input_tokens=True),
        lambda: LLMCall(model="m", request=LLMRequest(messages=[]), latency_ms=-1),
        lambda: LLMError(kind="timeout"),
        lambda: Artifact(name="a", path="p", bytes=-1),
        lambda: InstanceData(id=True),
        lambda: InstanceData(id="x", repeat=0),
        lambda: InstanceData(id="x", scores={"s": {"nested": 1}}),
        lambda: AgentEvent(agent="a", kind="vote", target="b"),
    ],
)
def test_constructor_rejects_invalid_data(construct):
    with pytest.raises(ValidationError):
        construct()


def test_assignment_and_nested_mutation_are_checked(event_capture):
    event = Metric(name="n", value=1)
    with pytest.raises(ValidationError):
        event.value = {}
    instance = Instance(agent="s", data=InstanceData(id="x", scores={"s": 1}))
    instance.data.scores["s"] = {}
    with pytest.raises((ValidationError, PydanticSerializationError)):
        emit(instance)
    assert event_capture.read() == []


def test_custom_events_use_public_container(event_capture):
    emit(CustomEvent(kind="werewolf.night", data={"victim": "alice", "unknown": None}))
    assert event_capture.read()[0] == {
        "type": "custom",
        "kind": "werewolf.night",
        "data": {"victim": "alice", "unknown": None},
    }


def test_private_models_and_lifecycle_cannot_be_emitted(event_capture):
    class Night(BaseModel):
        type: Literal["werewolf.night"] = "werewolf.night"
        victim: str

    class PrivateStatus(Status):
        pass

    for event in (
        Night(victim="alice"),
        PrivateStatus(detail="x"),
        RunStatus(state="running"),
        {"type": "status", "detail": "x"},
    ):
        with pytest.raises(TypeError, match="public producer model"):
            emit(event)
    assert event_capture.read() == []


def test_instance_has_its_own_wire_type(event_capture):
    emit(
        Instance(
            agent="solver",
            data=InstanceData(id="x", repeat=2, scores={"correct": True}, target="42"),
        )
    )
    event = event_capture.read()[0]
    assert event == {
        "type": "instance",
        "agent": "solver",
        "data": {
            "id": "x",
            "repeat": 2,
            "scores": {"correct": True},
            "target": "42",
            "error": None,
            "meta": None,
        },
    }
    assert validate_event(event) == []
    event["data"]["repeat"] = 0
    assert validate_event(event)


def test_ingestion_rejects_unknown_fields_without_mutating_evidence():
    event = {
        "type": "llm.call",
        "model": "m",
        "future": True,
        "request": {"messages": [], "future": {"field": 1}},
        "response": {"message": {}, "system_fingerprint": "fp"},
    }
    before = json.dumps(event)
    assert validate_event(event)
    assert json.dumps(event) == before
    event["request"]["messages"] = "bad"
    assert validate_event(event)
    for opaque in ({"type": "custom"}, {"no": "type"}, {"type": ["bad"]}):
        assert validate_event(opaque)


def test_concurrent_emitters_use_socket(event_capture):
    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(lambda i: emit(Metric(name="n", value=i)), range(100)))
    assert sorted(e["value"] for e in event_capture.read()) == list(range(100))


def test_json_schema_exposes_wire_discriminators_and_constraints():
    schemas = json_schemas()
    assert set(schemas) == {
        "status",
        "log",
        "stdout",
        "stderr",
        "metric",
        "message",
        "llm.call",
        "agent.event",
        "artifact",
        "instance",
        "custom",
        "run.start",
        "run.status",
        "run.end",
    }
    assert schemas["message"]["properties"]["type"]["const"] == "message"
    assert "from" in schemas["message"]["required"]
    assert schemas["message"]["additionalProperties"] is False
    assert (
        schemas["llm.call"]["$defs"]["LLMUsage"]["properties"]["input_tokens"]["anyOf"][
            0
        ]["minimum"]
        == 0
    )


def test_emission_validation_cannot_rewrite_payload(event_capture, monkeypatch):
    event = CustomEvent(kind="observation", data={"value": None, "number": 1.0})
    original = event.model_dump_json(by_alias=True)
    from adb_events.models import PRODUCER_ADAPTER

    validate = PRODUCER_ADAPTER.validate_json

    def normalize(payload, **kwargs):
        parsed = validate(payload, **kwargs)
        parsed.data["number"] = 999
        return parsed

    import importlib
    from types import SimpleNamespace

    module = importlib.import_module("adb_events.emit")
    monkeypatch.setattr(
        module, "PRODUCER_ADAPTER", SimpleNamespace(validate_json=normalize)
    )
    emit(event)
    assert event_capture.read() == [json.loads(original)]
    assert event.model_dump_json(by_alias=True) == original


def test_union_catches_constraints_that_serialization_accepts(event_capture):
    # An integer is serializable, but a negative latency violates the schema.
    event = LLMCall.model_construct(
        model="m", request=LLMRequest(messages=[]), latency_ms=-1
    )
    with pytest.raises(ValidationError):
        emit(event)
    assert event_capture.read() == []


def test_custom_data_requires_json_values():
    with pytest.raises(ValidationError):
        CustomEvent(kind="bad", data={"value": object()})
