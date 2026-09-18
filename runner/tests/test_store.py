"""One append-only stream per run."""

import json

from adb_runner import store as store_mod
from adb_runner.store import RunStore


def test_data_directory_environment_precedence(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path / "user"))
    monkeypatch.setenv("ADB_HOME", str(tmp_path / "obsolete"))
    monkeypatch.delenv("ADB_DATA_DIR", raising=False)
    monkeypatch.delenv("XDG_DATA_HOME", raising=False)
    assert store_mod.resolve_data_dir() == tmp_path / "user/.local/share/adb"
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "xdg"))
    assert store_mod.resolve_data_dir() == tmp_path / "xdg/adb"
    monkeypatch.setenv("ADB_DATA_DIR", str(tmp_path / "data"))
    assert store_mod.resolve_data_dir() == tmp_path / "data"
    monkeypatch.chdir(tmp_path)
    assert store_mod.resolve_data_dir("explicit") == tmp_path / "explicit"


def test_one_stream_preserves_all_records_in_order(tmp_path):
    s = RunStore(tmp_path, "cid", "20260916t120000z-012345abcdef", experiment="test")
    assert list(s.dir.iterdir()) == [s.workspace]
    for i in range(20):
        s.write_event({"v": 0, "seq": i, "event": {"type": "log", "message": "x" * 100_000}})
    s.close()

    assert sorted(p.name for p in s.dir.iterdir()) == ["events.jsonl", "workspace"]
    replayed = [json.loads(line) for line in (s.dir / "events.jsonl").read_text().splitlines()]
    assert [e["seq"] for e in replayed] == list(range(20))  # nothing lost or reordered


def test_condition_path_uses_both_fields_and_accepts_hyphenated_experiments(tmp_path):
    experiment = "inspect-task-with-hyphens"
    cid = "a" * 40
    rid = "20260916t120000z-012345abcdef"
    store = RunStore(tmp_path, cid, rid, experiment=experiment)
    assert store.dir == tmp_path / "runs" / (cid + "-" + experiment) / rid
    assert not (tmp_path / "conditions").exists()
    assert store_mod.find_run(tmp_path, rid) == store.dir
