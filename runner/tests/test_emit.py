"""CLI construction, socket delivery, and schema export."""

import io
import json
import sys

import pytest

from adb_runner.emit import main
from adb_events import validate_event


def emit(capsys, event_capture, *argv, stdin: str | None = None, monkeypatch=None):
    if stdin is not None:
        monkeypatch.setattr(sys, "stdin", io.StringIO(stdin))
    code = main(list(argv))
    out = capsys.readouterr()
    captured = event_capture.read() if event_capture is not None else []
    return code, (json.dumps(captured[0]) if captured else out.out), out.err


def test_message_round_trips(capsys, event_capture):
    code, out, _ = emit(
        capsys,
        event_capture,
        "message",
        "--from",
        "agent-2",
        "--channel",
        "town",
        "--content",
        "hi",
        "--visible-to",
        "a,b",
        "--meta",
        '{"day": 2}',
    )
    assert code == 0
    event = json.loads(out)
    assert event == {
        "type": "message",
        "from": "agent-2",
        "channel": "town",
        "content": "hi",
        "to": None,
        "visible_to": ["a", "b"],
        "meta": {"day": 2},
    }
    assert validate_event(event) == []


def test_missing_required_field_errors_loudly(capsys):
    code, out, err = emit(
        capsys, None, "message", "--from", "agent-2", "--channel", "town"
    )
    assert code == 2 and out == ""
    assert "content" in err and "invalid message" in err


def test_metric_value_is_jsonish(capsys, event_capture):
    _, out, _ = emit(
        capsys, event_capture, "metric", "--name", "rounds", "--value", "3"
    )
    assert json.loads(out)["value"] == 3
    _, out, _ = emit(
        capsys, event_capture, "metric", "--name", "winner", "--value", "village"
    )
    assert json.loads(out)["value"] == "village"  # not JSON → raw string


def test_bad_json_flag_is_a_clear_error(capsys):
    with pytest.raises(SystemExit, match="--meta expects JSON"):
        main(
            [
                "message",
                "--from",
                "a",
                "--channel",
                "t",
                "--content",
                "c",
                "--meta",
                "{not json",
            ]
        )


def test_llm_call_body_on_stdin(capsys, monkeypatch, event_capture):
    body = {
        "request": {"messages": [{"role": "user", "content": "q"}], "params": {}},
        "response": {"message": {"role": "assistant", "content": "r"}},
        "usage": {"input_tokens": 3, "output_tokens": 5},
    }
    code, out, _ = emit(
        capsys,
        event_capture,
        "llm-call",
        "--agent",
        "a",
        "--model",
        "mock/x",
        stdin=json.dumps(body),
        monkeypatch=monkeypatch,
    )
    assert code == 0
    event = json.loads(out)
    assert event["type"] == "llm.call" and event["model"] == "mock/x"
    assert event["request"]["messages"][0]["content"] == "q"
    assert validate_event(event) == []


def test_llm_call_missing_request_rejected(capsys, monkeypatch):
    code, _, err = emit(
        capsys,
        None,
        "llm-call",
        "--model",
        "mock/x",
        stdin="",
        monkeypatch=monkeypatch,
    )
    assert code == 2 and "request" in err


def test_schema_output_is_json_schema(capsys):
    code, out, _ = emit(capsys, None, "schema", "message")
    assert code == 0
    schema = json.loads(out)
    # Resolve either a referenced or inline JSON Schema definition.
    defn = schema.get("$defs", {}).get("Message", schema)
    assert "properties" in defn and "from" in defn["properties"]
    code, out, _ = emit(capsys, None, "schema")
    assert set(json.loads(out)) == {
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


def test_validate_event_lint_semantics():
    assert validate_event({"type": "custom.thing", "whatever": 1})  # undeclared type
    assert validate_event({"no_type": "opaque"})  # missing discriminator
    assert validate_event(
        {"type": "message", "from": "a", "channel": "t", "content": "c", "extra": True}
    )  # extras must go in meta
    problems = validate_event({"type": "metric", "name": "n"})  # value missing
    assert problems and "value" in problems[0]
    assert validate_event({"type": "stderr", "line": "oops"}) == []
    problems = validate_event({"type": "stdout"})  # line missing
    assert problems and "line" in problems[0]


def test_unknown_nested_author_fields_raise(capsys, monkeypatch):
    code, out, err = emit(
        capsys,
        None,
        "llm-call",
        "--model",
        "m",
        stdin=json.dumps({"request": {"messages": [], "prams": {}}}),
        monkeypatch=monkeypatch,
    )
    assert code == 2 and out == ""
    assert "prams" in err


def test_custom_and_instance_cli_use_public_models(capsys, event_capture):
    code, out, _ = emit(
        capsys,
        event_capture,
        "custom",
        "--kind",
        "govsim.state",
        "--data",
        '{"resource":42}',
    )
    assert code == 0
    assert json.loads(out) == {
        "type": "custom",
        "kind": "govsim.state",
        "data": {"resource": 42},
    }
    code, out, _ = emit(
        capsys,
        event_capture,
        "instance",
        "--agent",
        "solver",
        "--data",
        '{"id":"x","scores":{"correct":true}}',
    )
    assert code == 0 and json.loads(out)["type"] == "instance"


def test_union_and_envelope_schema_exports(capsys):
    for flag in ("--union", "--envelope"):
        code, out, _ = emit(capsys, None, "schema", flag)
        assert code == 0 and "$defs" in json.loads(out)
