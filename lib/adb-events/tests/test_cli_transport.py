"""The event CLI and Python producers share the reference receiver."""

import subprocess
import sys
from importlib.metadata import distribution
import json
from pathlib import Path

import pytest

from adb_events import EventTransportError, Result, emit
from adb_events.event_socket import event_socket


def test_installed_command_belongs_to_adb_events():
    entry, = [entry for entry in distribution("adb-events").entry_points if entry.name == "adb-emit"]
    assert entry.group == "console_scripts"
    assert entry.value == "adb_events.cli:main"
    completed = subprocess.run(
        [str(Path(sys.executable).parent / "adb-emit"), "schema", "result"],
        capture_output=True, text=True,
    )
    assert completed.returncode == 0, completed.stderr
    assert json.loads(completed.stdout)["properties"]["type"]["const"] == "result"


def test_cli_and_python_use_socket_without_stdout(monkeypatch, capsys):
    records = []
    with event_socket(records.append) as path:
        monkeypatch.setenv("ADB_EVENT_SOCKET", path)
        emit(Result(name="python", value=1))
        completed = subprocess.run(
            [
                sys.executable,
                "-m",
                "adb_events.cli",
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
            "adb_events.cli",
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
