"""File boundaries, byte identity, and lossless native checkpoint ingestion."""

import hashlib
import json

import pytest

from govsim_adapter.upstream import ingest_storage


def test_markers_identify_original_bytes_and_precede_untouched_rows(tmp_path, event_capture):
    files = {
        "log_env.json": [
            {"action": "future", "round": 3, "original": {"value": None}},
            {"action": ["unrecognized"], "round": 8},
        ],
        "persona_0/nodes.json": [{"id": 7, "description": "Keep café fish.", "extra": [None, {"x": 1}]}],
        "persona_2/nodes.json": [{"id": 4, "description": "Leave enough.", "unknown": False}],
    }
    for source, rows in files.items():
        path = tmp_path / source
        path.parent.mkdir(exist_ok=True)
        # Whitespace, Unicode and CRLF distinguish byte identity from reserialization.
        path.write_bytes((json.dumps(rows, ensure_ascii=False, indent=2) + "\r\n").encode())
    (tmp_path / "persona_0/embeddings.json").write_text("not JSON: must never be read")
    assert ingest_storage(tmp_path) == files["log_env.json"]
    events = iter(event_capture.read())
    for source, rows in files.items():
        marker = next(events)
        raw = (tmp_path / source).read_bytes()
        assert marker["kind"] == "govsim.upstream_log"
        assert marker["data"] == {"source": source, "bytes": len(raw),
                                  "sha256": hashlib.sha256(raw).hexdigest(), "records": len(rows)}
        for row in rows:
            event = next(events)
            if source == "log_env.json":
                assert event["kind"] == "govsim.record"
                assert event["data"] == row
            else:
                assert event["kind"] == "govsim.memory"
                assert event["data"] == {"persona": source.split("/")[0], "node": row}
    assert list(events) == []


@pytest.mark.parametrize("broken", ["unfinished", "{}", "[1]", '[{"value": NaN}]'])
def test_bad_file_keeps_its_evidence_and_does_not_hide_other_files(tmp_path, event_capture, broken):
    (tmp_path / "log_env.json").write_text(broken)
    for persona, text in [("persona_0", '[{"description":"saved"}]'),
                          ("persona_1", "unfinished memory"),
                          ("persona_2", '[{"description":"also saved"}]')]:
        directory = tmp_path / persona
        directory.mkdir()
        (directory / "nodes.json").write_text(text)
    with pytest.raises(ValueError):
        ingest_storage(tmp_path)
    events = event_capture.read()
    assert [e["data"]["records"] for e in events if e["kind"] == "govsim.upstream_log"] == [0, 1, 0, 1]
    assert [e["data"]["text"] for e in events if e["kind"] == "govsim.unparsed_log"] == [broken, "unfinished memory"]
    assert [e["data"]["persona"] for e in events if e["kind"] == "govsim.memory"] == ["persona_0", "persona_2"]


def test_memory_is_captured_when_environment_log_is_missing(tmp_path, event_capture):
    persona = tmp_path / "persona_5"
    persona.mkdir()
    (persona / "nodes.json").write_text('[{"description":"outsider checkpoint"}]')
    with pytest.raises(FileNotFoundError):
        ingest_storage(tmp_path)
    diagnostic, marker, memory = event_capture.read()
    assert diagnostic["kind"] == "govsim.unparsed_log"
    assert diagnostic["data"]["text"] == ""
    assert "log_env.json" in diagnostic["data"]["error"]
    assert marker["data"]["source"] == "persona_5/nodes.json"
    assert memory["data"]["persona"] == "persona_5"


def test_empty_files_have_markers_and_missing_files_have_diagnostics(tmp_path, event_capture):
    (tmp_path / "persona_0").mkdir()
    with pytest.raises(FileNotFoundError):
        ingest_storage(tmp_path)
    diagnostics = event_capture.read()
    assert len(diagnostics) == 2
    for event, source in zip(diagnostics, ["log_env.json", "persona_0/nodes.json"]):
        assert event["kind"] == "govsim.unparsed_log"
        assert event["data"]["text"] == ""
        assert source in event["data"]["error"]
    (tmp_path / "log_env.json").write_text("[]")
    (tmp_path / "persona_0/nodes.json").write_text("[]")
    assert ingest_storage(tmp_path) == []
    markers = event_capture.read()
    assert len(markers) == 2
    assert all(e["kind"] == "govsim.upstream_log" and e["data"]["records"] == 0 for e in markers)
