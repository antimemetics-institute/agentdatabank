"""adb-emit + the shared event models: strict at emission, lenient-with-warnings at
ingestion (the same models drive both)."""

import io
import json

import pytest

from adb_runner.emit import main
from adb_runner.events_schema import validate_event


def emit(capsys, *argv, stdin: str | None = None, monkeypatch=None):
    if stdin is not None:
        import sys
        monkeypatch.setattr(sys, "stdin", io.StringIO(stdin))
    code = main(list(argv))
    out = capsys.readouterr()
    return code, out.out, out.err


def test_message_round_trips(capsys):
    code, out, _ = emit(capsys, "message", "--from", "agent-2", "--channel", "town",
                        "--content", "hi", "--visible-to", "a,b", "--meta", '{"day": 2}')
    assert code == 0
    event = json.loads(out)
    assert event == {"type": "message", "from": "agent-2", "channel": "town",
                     "content": "hi", "visible_to": ["a", "b"], "meta": {"day": 2}}
    assert validate_event(event) == []


def test_missing_required_field_errors_loudly(capsys):
    code, out, err = emit(capsys, "message", "--from", "agent-2", "--channel", "town")
    assert code == 2 and out == ""
    assert "content" in err and "invalid message" in err


def test_metric_value_is_jsonish(capsys):
    _, out, _ = emit(capsys, "metric", "--name", "rounds", "--value", "3")
    assert json.loads(out)["value"] == 3
    _, out, _ = emit(capsys, "metric", "--name", "winner", "--value", "village")
    assert json.loads(out)["value"] == "village"  # not JSON → raw string


def test_bad_json_flag_is_a_clear_error(capsys):
    with pytest.raises(SystemExit, match="--meta expects JSON"):
        main(["message", "--from", "a", "--channel", "t", "--content", "c",
              "--meta", "{not json"])


def test_llm_call_body_on_stdin(capsys, monkeypatch):
    body = {"request": {"messages": [{"role": "user", "content": "q"}], "params": {}},
            "response": {"message": {"role": "assistant", "content": "r"}},
            "usage": {"input_tokens": 3, "output_tokens": 5}}
    code, out, _ = emit(capsys, "llm-call", "--agent", "a", "--model", "mock/x",
                        stdin=json.dumps(body), monkeypatch=monkeypatch)
    assert code == 0
    event = json.loads(out)
    assert event["type"] == "llm.call" and event["model"] == "mock/x"
    assert event["request"]["messages"][0]["content"] == "q"
    assert validate_event(event) == []


def test_llm_call_missing_request_rejected(capsys, monkeypatch):
    code, _, err = emit(capsys, "llm-call", "--model", "mock/x",
                        stdin="", monkeypatch=monkeypatch)
    assert code == 2 and "request" in err


def test_schema_output_is_json_schema(capsys):
    code, out, _ = emit(capsys, "schema", "message")
    assert code == 0
    schema = json.loads(out)
    # msgspec emits a $ref into $defs (standard JSON Schema); resolve to the def
    defn = schema.get("$defs", {}).get("Message", schema)
    assert "properties" in defn and "from" in defn["properties"]
    code, out, _ = emit(capsys, "schema")
    assert set(json.loads(out)) == {"status", "log", "stdout", "stderr", "metric",
                                    "message", "llm.call", "agent.event", "artifact"}


def test_validate_event_lint_semantics():
    assert validate_event({"type": "custom.thing", "whatever": 1}) == []  # unknown = legal
    assert validate_event({"no_type": "opaque"}) == []  # absent type = legal (opaque tier)
    assert validate_event({"type": "message", "from": "a", "channel": "t",
                           "content": "c", "extra": True}) == []  # extras preserved
    problems = validate_event({"type": "metric", "name": "n"})  # value missing
    assert problems and "value" in problems[0]
    assert validate_event({"type": "stderr", "line": "oops"}) == []
    problems = validate_event({"type": "stdout"})  # line missing
    assert problems and "line" in problems[0]
