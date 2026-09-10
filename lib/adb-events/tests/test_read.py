"""The public union is sufficient to decode a complete run without experiments."""

import json

import pytest
from pydantic import ValidationError

from adb_events import (
    EVENT_ADAPTER,
    EVENT_MODELS,
    Envelope,
    EventReadError,
    CustomEvent,
    Instance,
    LLMCall,
    RunStart,
    RunStatus,
    RunEnd,
    parse_event,
    read_events,
)

START = {
    "type": "run.start",
    "condition": "cid",
    "experiment": "test",
    "source": "content:sha256:test",
    "fetch_ref": "dirty:unknown",
    "dirty": True,
    "spec_params": {"model": "mock/model"},
    "realized_params": {"model": "mock/model"},
    "base_seed": 123,
    "replicates": 1,
    "seed": 42,
    "replicate": 1,
    "env": {
        "adb_runner": "0.1.0",
        "platform": "linux-x86_64",
        "experiment_bin": "/fixture/experiment",
        "runner_python": "/fixture/python",
        "runner_python_version": "3.13.14",
    },
    "result_definitions": {},
}
PAYLOADS = [
    START,
    {"type": "run.status", "state": "running"},
    {"type": "llm.call", "model": "mock/model", "request": {"messages": []}},
    {"type": "custom", "kind": "govsim.state", "data": {"resource": 42}},
    {
        "type": "instance",
        "agent": "solver",
        "data": {"id": "x", "scores": {"correct": True}},
    },
    {
        "type": "run.end",
        "state": "completed",
        "duration_s": 1.2,
        "summary": {"score": 1},
        "usage_totals": {"llm_calls": 1, "input_tokens": 0, "output_tokens": 0},
        "exit_code": 0,
    },
]


def record(payload, seq):
    return {
        "v": 0,
        "ts": "2026-09-08T00:00:00Z",
        "run": "rid",
        "seq": seq,
        "event": payload,
    }


def test_reader_decodes_complete_run_in_numeric_chunk_order(tmp_path):
    for name, indexes in (
        ("events-2.jsonl", range(3)),
        ("events-10.jsonl", range(3, 6)),
    ):
        (tmp_path / name).write_text(
            "".join(json.dumps(record(PAYLOADS[i], i)) + "\n" for i in indexes)
        )
    rows = list(read_events(tmp_path))
    assert [type(row.event) for row in rows] == [
        RunStart,
        RunStatus,
        LLMCall,
        CustomEvent,
        Instance,
        RunEnd,
    ]
    assert [row.seq for row in rows] == list(range(6))
    assert all(row.run == "rid" and row.ts == "2026-09-08T00:00:00Z" for row in rows)
    assert rows[3].event.data == {"resource": 42}
    for row in rows:
        assert type(parse_event(row.event.model_dump_json())) is type(row.event)


@pytest.mark.parametrize(
    "payload",
    [
        {"type": "govsim.state", "resource": 42},
        {"no": "type"},
        {"type": "metric", "name": "x", "value": {}},
        {"type": "instance", "agent": "a", "data": {"id": "x", "repeat": 0}},
        {"type": "custom", "kind": "x", "data": {}, "undeclared": 1},
    ],
)
def test_reader_errors_include_location_and_preserve_file(tmp_path, payload):
    path = tmp_path / "events-00001.jsonl"
    text = json.dumps(record(START, 0)) + "\n" + json.dumps(record(payload, 1)) + "\n"
    path.write_text(text)
    with pytest.raises(EventReadError, match=r"events-00001.jsonl:2:"):
        list(read_events(path))
    assert path.read_text() == text


def test_truncated_record_and_unsupported_envelope_version(tmp_path):
    path = tmp_path / "events-00001.jsonl"
    path.write_text('{"v":')
    with pytest.raises(EventReadError, match=":1:"):
        list(read_events(path))
    with pytest.raises(ValidationError):
        Envelope.model_validate({**record(START, 0), "v": 1})


def test_partial_run_is_readable_without_end(tmp_path):
    path = tmp_path / "events-00001.jsonl"
    path.write_text(json.dumps(record(START, 0)) + "\n")
    assert isinstance(next(read_events(path)).event, RunStart)


def test_registry_is_derived_from_union_discriminators():
    assert set(EVENT_MODELS) == set(
        EVENT_ADAPTER.json_schema()["discriminator"]["mapping"]
    )
