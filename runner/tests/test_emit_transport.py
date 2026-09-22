"""The runner CLI and Python producers share the reference receiver."""

import subprocess
import sys

import pytest

from adb_events import EventTransportError, Result, emit
from adb_events.event_socket import event_socket


def test_cli_and_python_use_socket_without_stdout(monkeypatch, capsys):
    records = []
    with event_socket(records.append) as path:
        monkeypatch.setenv("ADB_EVENT_SOCKET", path)
        emit(Result(name="python", value=1))
        completed = subprocess.run(
            [
                sys.executable,
                "-m",
                "adb_runner.emit",
                "result",
                "--name",
                "cli",
                "--value",
                "2",
            ],
            capture_output=True,
            text=True,
        )
        assert completed.returncode == 0, completed.stderr
        assert completed.stdout == ""
    assert [e.name for e in records] == ["python", "cli"]
    assert capsys.readouterr().out == ""


def test_missing_socket_is_loud(monkeypatch):
    monkeypatch.delenv("ADB_EVENT_SOCKET", raising=False)
    with pytest.raises(EventTransportError, match="unset"):
        emit(Result(name="n", value=1))
    completed = subprocess.run(
        [
            sys.executable,
            "-m",
            "adb_runner.emit",
            "result",
            "--name",
            "n",
            "--value",
            "1",
        ],
        capture_output=True,
        text=True,
    )
    assert completed.returncode == 2
    assert completed.stdout == ""
    assert "ADB_EVENT_SOCKET" in completed.stderr
