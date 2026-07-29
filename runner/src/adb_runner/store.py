"""Run directory persistence (docs/plan/v0.md §2).

runs/<condition_id>/<run_id>/{run.json, events-NNNNN.jsonl, artifacts/, workspace/}
conditions/<condition_id>.json — spec as written, once per condition.

Event files are chunked so periodic HF commits add blobs instead of rewriting one
growing file.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

CHUNK_BYTES = 1_000_000


def default_home() -> Path:
    if "ADB_HOME" in os.environ:
        return Path(os.environ["ADB_HOME"])
    xdg = os.environ.get("XDG_DATA_HOME", os.path.expanduser("~/.local/share"))
    return Path(xdg) / "adb"


def write_json_atomic(path: Path, obj) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, indent=2, sort_keys=True) + "\n")
    tmp.replace(path)


def find_run(home: Path, run_id: str) -> Path | None:
    """Locate a run directory by ULID. Run ids are globally unique but stored under
    their condition, so the condition segment is globbed."""
    matches = sorted((home / "runs").glob(f"*/{run_id}"))
    return matches[0] if matches else None


def ensure_condition(home: Path, condition_id: str, spec: dict) -> None:
    cdir = home / "conditions"
    cdir.mkdir(parents=True, exist_ok=True)
    cpath = cdir / f"{condition_id}.json"
    if not cpath.exists():
        write_json_atomic(cpath, spec)


class RunStore:
    def __init__(self, home: Path, condition_id: str, run_id: str):
        self.dir = home / "runs" / condition_id / run_id
        (self.dir / "artifacts").mkdir(parents=True, exist_ok=True)
        (self.dir / "workspace").mkdir(exist_ok=True)
        self._chunk_index = 1
        self._chunk_bytes = 0
        self._fh = None

    @property
    def workspace(self) -> Path:
        return self.dir / "workspace"

    @property
    def artifacts(self) -> Path:
        return self.dir / "artifacts"

    def _open_chunk(self):
        path = self.dir / f"events-{self._chunk_index:05d}.jsonl"
        self._fh = path.open("a")
        return self._fh

    def write_event(self, event: dict) -> str:
        line = json.dumps(event, separators=(",", ":"), ensure_ascii=False)
        fh = self._fh
        if fh is None:
            fh = self._open_chunk()
        elif self._chunk_bytes + len(line) > CHUNK_BYTES:
            fh.close()
            self._chunk_index += 1
            self._chunk_bytes = 0
            fh = self._open_chunk()
        fh.write(line + "\n")
        fh.flush()
        self._chunk_bytes += len(line) + 1
        return line

    def write_run_json(self, obj: dict) -> None:
        write_json_atomic(self.dir / "run.json", obj)

    def close(self) -> None:
        if self._fh is not None:
            self._fh.close()
            self._fh = None
