"""The experiment process must report crashes without losing event evidence."""

import json
import os
from pathlib import Path
import subprocess
import sys


def test_crash_exits_nonzero_and_keeps_partial_events_and_fallback(tmp_path, event_capture):
    root = Path(__file__).resolve().parents[3]
    env = dict(os.environ, ADB_RUN_DIR=str(tmp_path),
               PYTHONPATH=os.pathsep.join([str(root / 'lib' / 'adb-experiment'),
                                          str(root / 'lib' / 'adb-events')]))
    proc = subprocess.run(
        [
            sys.executable,
            "-c",
            """
from adb_events import Result, emit
from adb_experiment import experiment_main
class Params:
    @classmethod
    def model_validate(cls, raw):
        return raw

def run(params):
    emit(Result(name="observations", value=params["observations"]))
    raise RuntimeError("simulation crashed after observation")

raise SystemExit(experiment_main(Params, run, prog="crashing-experiment",
                                fallback_summary={"errors": 1}))
""",
        ],
        input='{"observations": 3}',
        text=True,
        capture_output=True,
        env=env,
        cwd=tmp_path,
        timeout=30,
    )
    assert proc.returncode == 1
    assert "RuntimeError: simulation crashed after observation" in proc.stderr
    events = event_capture.read()
    assert [(e['name'], e['value']) for e in events] == [('observations', 3), ('errors', 1)]
