"""Chunked event storage — chunk boundaries matter for HF incremental commits."""

import json

from adb_runner import store as store_mod
from adb_runner.store import RunStore


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
