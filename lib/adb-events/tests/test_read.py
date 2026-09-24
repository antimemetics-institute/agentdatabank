"""The public union is sufficient to decode a complete run without experiments."""

import json
from datetime import datetime, timezone
from typing import Annotated, Literal

import pytest
from pydantic import Field, TypeAdapter, ValidationError
from adb_events.models.base import Model

from adb_events import (
    EVENT_ADAPTER,
    EVENT_MODELS,
    Envelope,
    EventReadError,
    CustomEvent,
    Result,
    LLMCall,
    RunStart,
    RunEnd,
    parse_event,
    read_events,
)

START = {
    "type": "run.start",
    "condition": "cid",
    "source": "content:sha256:test",
    "params": {"model": "mock/model"},
    "seed": 42,
    "runtime": {
        "platform": "linux-x86_64",
        "runner_python_version": "3.13.14",
    },
    "result_definitions": [],
}
PAYLOADS = [
    START,
    {"type": "llm.call", "model": "mock/model", "input": [], "output": {}},
    {"type": "custom", "kind": "govsim.state", "data": {"resource": 42}},
    {
        "type": "result",
        "name": "correct",
        "value": True,
    },
    {
        "type": "run.end",
        "state": "completed",
        "duration_s": 1.2,
        "exit_code": 0,
    },
]


def record(payload, seq):
    return {
        "v": 0,
        "ts": "2026-09-08T00:00:00Z",
        "run": "20260916t120000z-012345abcdef",
        "experiment": "test",
        "schema": 0,
        "seq": seq,
        "event": payload,
    }


def test_reader_decodes_complete_run_from_one_stream(tmp_path):
    (tmp_path / "events.jsonl").write_text(
        "".join(json.dumps(record(payload, i)) + "\n" for i, payload in enumerate(PAYLOADS))
    )
    rows = list(read_events(tmp_path))
    assert [type(row.event) for row in rows] == [
        RunStart,
        LLMCall,
        CustomEvent,
        Result,
        RunEnd,
    ]
    assert [row.seq for row in rows] == list(range(5))
    assert all(row.run == "20260916t120000z-012345abcdef" and row.ts == datetime(2026, 9, 8, tzinfo=timezone.utc)
               for row in rows)
    assert rows[2].event.data == {"resource": 42}
    for row in rows:
        assert type(parse_event(row.event.model_dump_json())) is type(row.event)


@pytest.mark.parametrize(
    "payload",
    [
        {"type": "govsim.state", "resource": 42},
        {"no": "type"},
        {"type": "result", "name": "x", "value": {}},
        {"type": "instance", "agent": "a", "data": {"id": "x", "repeat": 0}},
        {"type": "custom", "kind": "x", "data": {}, "undeclared": 1},
    ],
)
def test_reader_errors_include_location_and_preserve_file(tmp_path, payload):
    path = tmp_path / "events.jsonl"
    text = json.dumps(record(START, 0)) + "\n" + json.dumps(record(payload, 1)) + "\n"
    path.write_text(text)
    with pytest.raises(EventReadError, match=r"events.jsonl:2:"):
        list(read_events(path))
    assert path.read_text() == text


def test_truncated_record_and_unsupported_envelope_version(tmp_path):
    path = tmp_path / "events.jsonl"
    path.write_text('{"v":')
    with pytest.raises(EventReadError, match=":1:"):
        list(read_events(path))
    with pytest.raises(ValidationError):
        Envelope.model_validate({**record(START, 0), "v": 1})


def test_partial_run_is_readable_without_end(tmp_path):
    path = tmp_path / "events.jsonl"
    path.write_text(json.dumps(record(START, 0)) + "\n")
    assert isinstance(next(read_events(path)).event, RunStart)


def test_only_the_single_stream_filename_is_accepted(tmp_path):
    old = tmp_path / "events-00001.jsonl"
    old.write_text(json.dumps(record(START, 0)) + "\n")
    with pytest.raises(FileNotFoundError, match="events.jsonl"):
        list(read_events(tmp_path))
    with pytest.raises(ValueError, match="named events.jsonl"):
        list(read_events(old))
    (tmp_path / "events.jsonl").write_text(old.read_text())
    old.write_text("not a stream we read\n")
    assert len(list(read_events(tmp_path))) == 1


def test_registry_is_derived_from_union_discriminators():
    assert set(EVENT_MODELS) == set(
        EVENT_ADAPTER.json_schema()["discriminator"]["mapping"]
    )


def test_v0_has_exactly_the_nine_shared_tags():
    assert set(EVENT_MODELS) == {
        "run.start", "run.end", "llm.call", "custom", "result",
        "status", "log", "stdout", "stderr",
    }


@pytest.mark.parametrize("field,value", [("experiment", "test"), ("dirty", True), ("env", {})])
def test_start_rejects_removed_provenance_fields(field, value):
    with pytest.raises(ValidationError):
        RunStart.model_validate({**START, field: value})


@pytest.mark.parametrize("state", ["provisioning", "running", "completed", "failed", "interrupted"])
def test_run_status_is_not_a_shared_event(state):
    with pytest.raises(ValidationError):
        parse_event({"type": "run.status", "state": state})


@pytest.mark.parametrize("change", [{"schema": -1}, {"schema": True}, {"experiment": 1}])
def test_envelope_identity_is_strict(change):
    with pytest.raises(ValidationError):
        Envelope.model_validate_json(json.dumps({**record(START, 0), **change}))


@pytest.mark.parametrize("field", ["experiment", "schema"])
def test_envelope_identity_is_required(field):
    value = record(START, 0)
    del value[field]
    with pytest.raises(ValidationError):
        Envelope.model_validate_json(json.dumps(value))


class ObservationData(Model):
    resource: int


class Observation(Model):
    type: Literal["custom"] = "custom"
    kind: Literal["test.observation"] = "test.observation"
    data: ObservationData


TestPayload = Annotated[Observation | RunStart | RunEnd, Field(discriminator="type")]


@pytest.mark.parametrize("payload", [TestPayload, TypeAdapter(TestPayload)])
def test_reader_accepts_experiment_union_or_adapter(tmp_path, payload):
    path = tmp_path / "events.jsonl"
    path.write_text(json.dumps(record({
        "type": "custom", "kind": "test.observation", "data": {"resource": 42},
    }, 0)) + "\n")
    [row] = read_events(path, payload=payload)
    assert isinstance(row.event, Observation)
    assert row.event.data.resource == 42
    assert isinstance(next(read_events(path)).event, CustomEvent)
    text = path.read_text().replace('"resource": 42', '"resource": "bad"')
    path.write_text(text)
    with pytest.raises(EventReadError, match=r"events.jsonl:1:"):
        list(read_events(path, payload=payload))
    assert path.read_text() == text


def test_lifecycle_models_contain_only_launch_and_process_facts():
    from adb_events import RunEnvironment

    assert set(RunStart.model_fields) == {"type", "condition", "source", "fetch_ref", "tree_hash",
                                        "params", "seed", "runtime", "result_definitions"}
    assert set(RunEnd.model_fields) == {"type", "state", "duration_s", "exit_code"}
    assert set(RunEnvironment.model_fields) == {"platform", "runner_python_version", "experiment_bin", "runner_bin", "endpoints", "cpu_model", "cpu_count"}
    with pytest.raises(ValidationError):
        RunStart.model_validate({**START, "replicate": 1})
    for field in ("summary", "usage_totals"):
        with pytest.raises(ValidationError):
            RunEnd.model_validate({"state": "completed", "duration_s": 1, "exit_code": 0, field: {}})
