"""The runner protocol, exercised against a real subprocess — a fixture script speaking
the contract (params on stdin, event payloads on stdout). This is the seam every
experiment in any language crosses; no mocks, the fixture IS a minimal experiment."""

import json
import stat

import pytest

from adb_runner.protocol import execute_run
from adb_runner.store import RunStore

MANIFEST = {"name": "t", "params": {"x": {"type": {"kind": "int"}, "default": 1}},
            "results": {"m": {"type": {"kind": "int"}, "label": "Measurement",
                              "description": "The measured count.", "unit": "items",
                              "details": "Count recorded by the fixture."},
                        "missing": {"type": {"kind": "float"}}}}

FIXTURE = r"""#!/bin/sh
read -r params
echo "{\"type\":\"status\",\"detail\":\"got $params\"}"
echo '{"type":"status","phase":"experiment-stage"}'
echo '{"type":"metric","name":"m","value":42}'
echo '{"type":"metric","name":"undeclared","value":1}'
echo '{"type":"message","from":"a","channel":"town","content":"hi"}'
echo '{"type":"llm.call","agent":"a","model":"mock/x","request":{"messages":[{"role":"user","content":"q"}],"params":{}},"response":{"message":{"role":"assistant","content":"r"}},"usage":{"input_tokens":3,"output_tokens":5}}'
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
    prog.write_text(script)
    prog.chmod(prog.stat().st_mode | stat.S_IEXEC)
    store = RunStore(tmp_path / "home", "cid", "rid")
    result = execute_run(
        program=str(prog), manifest=MANIFEST if manifest is None else manifest,
        spec_params={"x": 1}, realized_params=params or {"x": 1},
        condition_id="cid", source="dirty:test", seed=7, replicate=1,
        store=store, run_id="rid", on_event=on_event,
    )
    envelopes = [json.loads(line)
                 for f in sorted(store.dir.glob("events-*.jsonl"))
                 for line in f.read_text().splitlines()]
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
    assert {"type": "status", "phase": "experiment-stage"} in payloads
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
    assert end["usage_totals"] == {"input_tokens": 3, "output_tokens": 5, "llm_calls": 1}

    by_type = {}
    for p in payloads:
        by_type.setdefault(p.get("type"), []).append(p)
    # conformance ladder: everything the process printed is preserved, nothing mutated
    # - reserved run.* from the experiment: kept verbatim, flagged in a warning
    assert any(p.get("fake") == "reserved" for p in by_type["run.end"])
    logs = " ".join(p["message"] for p in by_type["log"])
    assert "reserved" in logs
    # - custom-typed and untyped payloads pass through untouched
    assert by_type["t.custom"] == [{"type": "t.custom", "anything": 1}]
    assert {"no_type": "opaque blob"} in by_type[None]
    # - non-object stdout (JSON array, plain text) → stdout events, verbatim
    stdout_lines = [p["line"] for p in by_type["stdout"]]
    assert "[1, 2, 3]" in stdout_lines and "not json at all" in stdout_lines
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

    script = "#!/bin/sh\necho '{\"type\":\"metric\",\"name\":\"m\",\"value\":\"unavailable\"}'\n"
    result, envelopes, store = run_fixture(
        tmp_path, script=script, manifest=manifest, on_event=change_catalog,
    )
    assert result.state == "completed"
    assert result.summary == {"m": "unavailable"}
    assert envelopes[0]["event"]["result_definitions"] == expected
    assert json.loads((store.dir / "run.json").read_text())["result_definitions"] == expected


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
    line = next(p["line"] for p in payloads
                if p.get("type") == "stdout" and "params=" in p["line"])
    assert '"x": 9' in line and "seed=7" in line and "run=rid" in line


def test_orphaned_pipe_holders_do_not_hang_the_run(tmp_path):
    # a grandchild inheriting our pipes outlives the experiment; the reader loop
    # must drain and close within its grace period instead of waiting for EOF
    import time as _time
    script = "#!/bin/sh\nsleep 30 &\necho '{\"type\":\"status\",\"detail\":\"bye\"}'\nexit 0\n"
    start = _time.monotonic()
    result, envelopes, _ = run_fixture(tmp_path, script=script)
    assert _time.monotonic() - start < 25  # not held hostage by the sleeping orphan
    assert result.state == "completed"
    assert any("descendants still hold" in str(e["event"].get("message", ""))
               for e in envelopes)


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
