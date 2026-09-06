"""Chunked event storage — chunk boundaries matter for HF incremental commits."""

import json

from adb_runner import store as store_mod
from adb_runner.store import RunStore


def test_data_directory_environment_precedence(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path / "user"))
    monkeypatch.setenv("ADB_HOME", str(tmp_path / "obsolete"))
    monkeypatch.delenv("ADB_DATA_DIR", raising=False)
    monkeypatch.delenv("XDG_DATA_HOME", raising=False)
    assert store_mod.default_home() == tmp_path / "user/.local/share/adb"
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "xdg"))
    assert store_mod.default_home() == tmp_path / "xdg/adb"
    monkeypatch.setenv("ADB_DATA_DIR", str(tmp_path / "data"))
    assert store_mod.default_home() == tmp_path / "data"


def test_chunks_rotate_and_replay_in_order(tmp_path, monkeypatch):
    monkeypatch.setattr(store_mod, "CHUNK_BYTES", 200)
    s = RunStore(tmp_path, "cid", "rid")
    for i in range(20):
        s.write_event({"v": 0, "seq": i, "event": {"type": "log", "message": "x" * 30}})
    s.close()

    chunks = sorted(s.dir.glob("events-*.jsonl"))
    assert len(chunks) > 1  # rotation happened
    replayed = [json.loads(line) for c in chunks for line in c.read_text().splitlines()]
    assert [e["seq"] for e in replayed] == list(range(20))  # nothing lost or reordered
