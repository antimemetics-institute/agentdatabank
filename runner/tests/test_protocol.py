"""The runner protocol, exercised against a real subprocess — a fixture script speaking
the contract (params on stdin, event payloads on a Unix socket). This is the seam every
experiment in any language crosses; no mocks, the fixture IS a minimal experiment."""

import json
import stat
import shlex
import sys

import pytest

from adb_runner.protocol import execute_run
from adb_runner.store import RunStore

MANIFEST = {
    "name": "t",
    "params": {"x": {"type": {"kind": "int"}, "default": 1}},
    "results": {
        "m": {
            "type": {"kind": "int"},
            "label": "Measurement",
            "description": "The measured count.",
            "unit": "items",
            "details": "Count recorded by the fixture.",
        },
        "missing": {"type": {"kind": "float"}},
    },
}

FIXTURE = r"""#!/bin/sh
read -r params
adb-emit status --detail "got $params"
echo '{"type":"status","phase":"experiment-stage"}'
adb-emit metric --name m --value 42
adb-emit metric --name undeclared --value 1
adb-emit message --from a --channel town --content hi
adb-emit llm-call --agent a --model mock/x <<'EOF'
{ "request":{"messages":[{"role":"user","content":"q"}],"params":{}},"response":{"message":{"role":"assistant","content":"r"}},"usage":{"input_tokens":3,"output_tokens":5}}
EOF
echo '{"type":"run.end","fake":"reserved"}'
echo '{"type":"t.custom","anything":1}'
echo '{"no_type":"opaque blob"}'
echo '[1, 2, 3]'
echo 'not json at all'
echo "to stderr" >&2
exit 0
"""


def run_fixture(tmp_path, script=FIXTURE, params=None, manifest=None, on_event=None):
    prog = tmp_path / "exp.sh"
    # Exercise the real CLI using this test environment's Python.
    cli = f'adb-emit() {{ {shlex.quote(sys.executable)} -m adb_runner.emit "$@"; }}\n'
    prog.write_text(script.replace("#!/bin/sh\n", "#!/bin/sh\n" + cli, 1))
    prog.chmod(prog.stat().st_mode | stat.S_IEXEC)
    store = RunStore(tmp_path / "home", "cid", "rid")
    result = execute_run(
        program=str(prog),
        manifest=MANIFEST if manifest is None else manifest,
        spec_params={"x": 1},
        realized_params=params or {"x": 1},
        condition_id="cid",
        source="dirty:test",
        seed=7,
        replicate=1,
        store=store,
        run_id="rid",
        on_event=on_event,
    )
    envelopes = [
        json.loads(line)
        for f in sorted(store.dir.glob("events-*.jsonl"))
        for line in f.read_text().splitlines()
    ]
    return result, envelopes, store


def test_protocol_end_to_end(tmp_path):
    result, envelopes, store = run_fixture(tmp_path)

    assert result.state == "completed"
    # transport envelope: runner owns v/ts/run/seq; the payload rides under `event`
    assert [e["seq"] for e in envelopes] == list(range(len(envelopes)))
    assert all(e["v"] == 0 and e["run"] == "rid" and "event" in e for e in envelopes)
    payloads = [e["event"] for e in envelopes]

    record = json.loads((store.dir / "run.json").read_text())
    assert record["state"] == "completed" and "phase" not in record
    assert payloads[1] == {"type": "run.status", "state": "running"}
    assert {
        "type": "stdout",
        "line": '{"type":"status","phase":"experiment-stage"}',
        "meta": None,
    } in payloads
    assert payloads[-1]["state"] == "completed" and "phase" not in payloads[-1]

    start = payloads[0]
    assert start["type"] == "run.start"
    assert start["spec_params"] == {"x": 1} and start["realized_params"] == {"x": 1}
    assert start["dirty"] is True
    assert start["result_definitions"] == MANIFEST["results"]
    assert record["result_definitions"] == MANIFEST["results"]

    end = payloads[-1]
    assert end["type"] == "run.end" and "fake" not in end  # the runner's own, last
    assert end["summary"] == {"m": 42, "undeclared": 1}
    assert record["summary"] == result.summary == end["summary"]
    assert "missing" not in end["summary"]
    assert end["usage_totals"] == {
        "input_tokens": 3,
        "output_tokens": 5,
        "llm_calls": 1,
    }

    by_type = {}
    for p in payloads:
        by_type.setdefault(p.get("type"), []).append(p)
    # Even event-shaped JSON printed to stdout remains text.
    assert len(by_type["run.end"]) == 1
    assert "t.custom" not in by_type and None not in by_type
    stdout_lines = [p["line"] for p in by_type["stdout"]]
    assert '{"type":"run.end","fake":"reserved"}' in stdout_lines
    assert '{"no_type":"opaque blob"}' in stdout_lines
    assert "[1, 2, 3]" in stdout_lines and "not json at all" in stdout_lines
    from adb_events import read_events

    assert len(list(read_events(store.dir))) == len(envelopes)
    # - stderr → stderr events, no invented level
    assert [p["line"] for p in by_type["stderr"]] == ["to stderr"]

    # no views are materialized: projections are rendered on demand —
    # the deposit carries irreducibles only
    assert not (store.artifacts / "chat.jsonl").exists()
    assert not (store.artifacts / "llm_calls.jsonl").exists()
    assert "artifact" not in by_type


@pytest.mark.parametrize("results", [None, {}])
def test_no_declarations_still_captures_metrics(tmp_path, results):
    manifest = {"name": "t", "params": MANIFEST["params"]}
    if results is not None:
        manifest["results"] = results
    result, envelopes, store = run_fixture(tmp_path, manifest=manifest)
    assert result.summary == {"m": 42, "undeclared": 1}
    assert envelopes[0]["event"]["result_definitions"] == {}
    assert json.loads((store.dir / "run.json").read_text())["result_definitions"] == {}


def test_declarations_are_snapshotted_and_do_not_validate_values(tmp_path):
    from copy import deepcopy

    manifest = deepcopy(MANIFEST)
    expected = deepcopy(manifest["results"])

    def change_catalog(envelope):
        if envelope["event"].get("type") == "run.start":
            manifest["results"]["m"]["label"] = "Changed during run"
            manifest["results"]["m"]["details"] = "Changed calculation explanation"
            manifest["results"]["added"] = {"type": {"kind": "bool"}}

    script = "#!/bin/sh\nadb-emit metric --name m --value unavailable\n"
    result, envelopes, store = run_fixture(
        tmp_path,
        script=script,
        manifest=manifest,
        on_event=change_catalog,
    )
    assert result.state == "completed"
    assert result.summary == {"m": "unavailable"}
    assert envelopes[0]["event"]["result_definitions"] == expected
    assert (
        json.loads((store.dir / "run.json").read_text())["result_definitions"]
        == expected
    )


def test_nonzero_exit_is_failed(tmp_path):
    result, envelopes, _ = run_fixture(tmp_path, script="#!/bin/sh\nexit 3\n")
    assert result.state == "failed"
    assert envelopes[-1]["event"]["exit_code"] == 3


def test_experiment_receives_params_and_env(tmp_path):
    # plain-text echo: lands in the stream as a captured `stdout` event, verbatim —
    # which is also the capture path a no-adapter wrapped tool exercises
    script = r"""#!/bin/sh
read -r p
echo "params=$p seed=$ADB_SEED run=$ADB_RUN_ID"
"""
    _, envelopes, _ = run_fixture(tmp_path, script=script, params={"x": 9})
    payloads = [e["event"] for e in envelopes]
    line = next(
        p["line"]
        for p in payloads
        if p.get("type") == "stdout" and "params=" in p["line"]
    )
    assert '"x": 9' in line and "seed=7" in line and "run=rid" in line


def test_orphaned_pipe_holders_do_not_hang_the_run(tmp_path):
    # a grandchild inheriting our pipes outlives the experiment; the reader loop
    # must drain and close within its grace period instead of waiting for EOF
    import time as _time

    script = (
        '#!/bin/sh\nsleep 30 &\necho \'{"type":"status","detail":"bye"}\'\nexit 0\n'
    )
    start = _time.monotonic()
    result, envelopes, _ = run_fixture(tmp_path, script=script)
    assert _time.monotonic() - start < 25  # not held hostage by the sleeping orphan
    assert result.state == "completed"
    assert any(
        "descendants still hold" in str(e["event"].get("message", ""))
        for e in envelopes
    )


def test_child_env_is_constructed_not_inherited(monkeypatch):
    # the store is the ONLY way provider credentials reach a run: an ambient key or
    # base-url exported in the shell neither leaks in nor shadows the stored value
    from adb_runner.protocol import child_env

    monkeypatch.setenv("OPENAI_API_KEY", "sk-ambient")
    monkeypatch.setenv("OPENAI_BASE_URL", "http://ambient/v1")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "aws-ambient")
    monkeypatch.setenv("DOCKER_HOST", "unix:///run/user/1000/docker.sock")
    env = child_env("rid", "/run/dir", 7, {"OPENAI_API_KEY": "sk-stored"})
    assert env["OPENAI_API_KEY"] == "sk-stored"  # store wins over host
    assert "OPENAI_BASE_URL" not in env
    assert "AWS_SECRET_ACCESS_KEY" not in env
    assert env["DOCKER_HOST"] == "unix:///run/user/1000/docker.sock"  # allowlisted
    assert env["ADB_RUN_ID"] == "rid" and env["ADB_SEED"] == "7"


def test_saved_run_deserializes_with_public_models(tmp_path):
    from adb_events import CustomEvent, Instance, RunEnd, RunStart, read_events

    script = """#!/bin/sh
adb-emit custom --kind t.observation --data '{"resource":42}'
adb-emit instance --agent solver --data '{"id":"item-1","scores":{"correct":true}}'
"""
    result, envelopes, store = run_fixture(tmp_path, script=script)
    records = list(read_events(store.dir))
    assert result.state == "completed"
    assert len(records) == len(envelopes)
    assert isinstance(records[0].event, RunStart)
    assert isinstance(records[2].event, CustomEvent)
    assert records[2].event.data == {"resource": 42}
    assert isinstance(records[3].event, Instance)
    assert isinstance(records[-1].event, RunEnd)


def test_invalid_metrics_and_usage_do_not_break_run_or_poison_totals(tmp_path):
    from adb_events import read_events

    script = """#!/bin/sh
adb-emit metric --name m --value 42
echo '{"type":"metric","name":"m","value":{"bad":1}}'
echo '{"type":"llm.call","agent":"a","model":"x","usage":{"input_tokens":"bad"}}'
"""
    result, envelopes, store = run_fixture(tmp_path, script=script)
    assert result.state == "completed"
    assert result.summary == {"m": 42}
    assert envelopes[-1]["event"]["usage_totals"] == {
        "llm_calls": 0,
        "input_tokens": 0,
        "output_tokens": 0,
    }
    assert any('"bad":1' in e["event"].get("line", "") for e in envelopes)
    assert len(list(read_events(store.dir))) == len(envelopes)


def test_concurrent_processes_record_large_events_and_cleanup_socket(tmp_path):
    from pathlib import Path
    from adb_events import CustomEvent, read_events

    child_code = "from adb_events import CustomEvent,emit; import sys; i=int(sys.argv[1]); emit(CustomEvent(kind='parallel',data={'id':i,'text':str(i)*200000}))"
    script = f"""#!{sys.executable}
import os, subprocess, sys
print(os.environ["ADB_EVENT_SOCKET"], flush=True)
children = [subprocess.Popen([sys.executable, "-c", {child_code!r}, str(i)]) for i in range(8)]
assert all(child.wait() == 0 for child in children)
"""
    result, envelopes, store = run_fixture(tmp_path, script=script)
    assert result.state == "completed"
    records = list(read_events(store.dir))
    events = [r.event for r in records if isinstance(r.event, CustomEvent)]
    assert sorted(e.data["id"] for e in events) == list(range(8))
    assert all(e.data["text"] == str(e.data["id"]) * 200000 for e in events)
    assert [r.seq for r in records] == list(range(len(records)))
    socket_path = next(
        e["event"]["line"] for e in envelopes if e["event"]["type"] == "stdout"
    )
    assert not Path(socket_path).exists()
