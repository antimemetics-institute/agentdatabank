"""Exercise the real runner, socket, upstream simulation, store, and typed reader."""

import importlib
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import sys

import pytest
from pydantic import BaseModel

from adb_events import LLMCall, RunEnd, read_events
from adb_events.render import hint_paths
from adb_providers import PROVIDERS
from adb_runner.protocol import execute_run
from adb_runner.store import RunStore
from adb_testing import assert_run_has_no_secrets
from govsim_adapter.models import Payload


# Exercise every supported credential environment, even though this run is
# offline. This catches accidental environment/config/request logging.
CREDENTIAL_ENV = {
    key: value for name, provider in PROVIDERS.items() for key, value in (
        (provider.api_key.name, f"sk-{name}-" + "a" * 40),
        (provider.base_url.name,
         f"https://fixture-user:fixture-password@{name}.fixture.invalid/private-endpoint?token=hidden"),
    )
} | {
    "WANDB_API_KEY": "wandb-fixture-" + "b" * 40,
    "HF_TOKEN": "hf_" + "c" * 40,
    "ADB_TEST_SECRET": "fixture-secret-" + "d" * 40,
    "ADB_TEST_PASSWORD": "fixture-password-" + "e" * 40,
    "ADB_TEST_CREDENTIAL": "fixture-credential-" + "f" * 40,
    "ADB_TEST_AUTH_TOKEN": "Bearer fixture-auth-" + "g" * 40,
}


@pytest.fixture(scope="module")
def manifest():
    catalog = os.environ.get("ADB_TEST_MANIFESTS")
    if not catalog:
        pytest.skip("requires Nix manifests (ADB_TEST_MANIFESTS)")
    return json.loads((Path(catalog) / "govsim.json").read_text())


def run_mock(tmp_path, manifest, *, setup="", credential_env=None, expected_state="completed"):
    upstream = os.environ.get("GOVSIM_UPSTREAM")
    if not upstream:
        pytest.skip("requires pinned upstream checkout (GOVSIM_UPSTREAM)")
    script = tmp_path / "launch.py"
    script.write_text(setup + "\nfrom govsim_adapter.main import main\nraise SystemExit(main())\n")
    program = tmp_path / "govsim"
    program.write_text(
        "#!/bin/sh\n"
        f"export GOVSIM_UPSTREAM={shlex.quote(upstream)}\n"
        f"export PYTHONPATH={shlex.quote(upstream)}\n"
        # Unpatched uv wheels on NixOS need the dev shell's library search path.
        # The packaged program carries these dependencies in its own closure.
        f"export LD_LIBRARY_PATH={shlex.quote(os.environ.get('LD_LIBRARY_PATH', ''))}\n"
        "export HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1\n"
        f"exec {shlex.quote(sys.executable)} {shlex.quote(str(script))}\n",
    )
    program.chmod(0o755)
    params = {name: declaration["initial"] for name, declaration in manifest["params"].items()}
    params.update(max_rounds=1, model="mock/model", embedder="hash")
    store = RunStore(tmp_path / "data", "test-condition", "20260916t120000z-012345abcdef", experiment="govsim")
    result = execute_run(
        program=str(program), manifest=manifest, params=params, condition_id="test-condition", source="test-source",
        fetch_ref="dirty:test", seed=37,
        store=store, run_id="20260916t120000z-012345abcdef", credential_env=credential_env or {},
    )
    wire = [json.loads(line) for path in sorted(store.dir.glob("events.jsonl"))
            for line in path.read_text().splitlines()]
    assert result.state == expected_state, [r["event"] for r in wire if r["event"]["type"] == "stderr"]
    return store, wire


def test_served_model_mismatch_fails_real_upstream_instead_of_using_default_answers(tmp_path, manifest):
    # Replace only the network. The real upstream wrapper normally catches model
    # exceptions and supplies default answers; a routing error must stop this run.
    setup = '''
from adb_experiment.llm import ChatClient
from openai.types.chat import ChatCompletion
def wrong_model(self, kw):
    self.is_mock = False
    self._request = lambda kw: ChatCompletion.model_validate({
        "id": "mismatch", "object": "chat.completion", "created": 0,
        "model": "wrong-model", "choices": [{"index": 0, "finish_reason": "stop",
            "message": {"role": "assistant", "content": "5"}}],
    })
    return self._create(**kw)
ChatClient._mock_create = wrong_model
'''
    _, wire = run_mock(tmp_path, manifest, setup=setup, expected_state="failed")
    calls = [r for r in wire if r["event"]["type"] == "llm.call"]
    assert len(calls) == 1
    call = calls[0]
    assert call["event"]["output"]["model"] == "wrong-model"
    assert call["event"]["call"]["response"]["model"] == "wrong-model"
    assert wire[call["seq"] + 1]["event"]["type"] == "log"
    assert wire[call["seq"] + 1]["event"]["level"] == "error"
    assert "mock/model" in wire[call["seq"] + 1]["event"]["message"]
    assert "wrong-model" in wire[call["seq"] + 1]["event"]["message"]


@pytest.fixture(scope="module")
def completed_run(tmp_path_factory, manifest):
    # Replace all credential-shaped host variables before launching. This avoids
    # passing real credentials and gives unrelated shell settings (KEYTIMEOUT)
    # unmistakable sentinel values instead of short numbers found in every run.
    seeded_env = {
        name: f"fixture-env-{name}-" + "h" * 40 for name in os.environ
        if re.search(r"KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL", name, re.IGNORECASE)
    } | CREDENTIAL_ENV
    # Prove the runner actually forwarded these values; never print them.
    setup = ("import os\n" +
             f"assert all(os.environ.get(k) == v for k, v in {seeded_env!r}.items())\n")
    with pytest.MonkeyPatch.context() as environment:
        for name, value in seeded_env.items():
            environment.setenv(name, value)
        yield run_mock(tmp_path_factory.mktemp("govsim-runner"), manifest,
                       setup=setup, credential_env=seeded_env)


def test_real_runner_emits_govsim_schema_zero(completed_run, manifest):
    store, wire = completed_run
    assert not (store.dir / "schema.json").exists()
    assert not (store.dir / "shared-schema.json").exists()
    module, attr = manifest["schema"]["models"].split(":")
    assert getattr(importlib.import_module(module), attr) is Payload
    assert manifest["schema"]["version"] == 0
    records = list(read_events(store.dir, payload=Payload))
    assert len(records) == len(wire)
    assert all(r.experiment == "govsim" and r.schema_ == 0 for r in records)
    assert all(r["experiment"] == "govsim" and r["schema"] == 0 for r in wire)
    assert [r.seq for r in records] == list(range(len(records)))
    customs = [r.event for r in records if r.event.type == "custom"]
    assert customs and all(isinstance(e.data, BaseModel) for e in customs)
    for event in customs:
        for path in hint_paths(event.render):
            value = event.model_dump(mode="json")
            for part in path.split("."):
                assert part in value, (event.kind, path)
                value = value[part]
    assert next(e.data.embedder for e in customs if e.kind == "govsim.config") == "hash"
    assert {e.kind for e in customs} == {
        "govsim.config", "govsim.state", "govsim.upstream_log",
        "govsim.memory", "govsim.harvest", "govsim.utterance",
        "govsim.summary", "govsim.resource_limit",
    }
    end = records[-1].event
    assert isinstance(end, RunEnd)
    results = {r.event.name: r.event.value for r in records if r.event.type == "result"}
    assert set(results) == {result["name"] for result in manifest["results"]}
    assert "model_calls" not in results
    assert set(end.model_dump()) == {"type", "state", "duration_s", "exit_code"}
    calls = [r.event for r in records if isinstance(r.event, LLMCall)]
    assert {call.agent for call in calls} == {
        *(f"persona_{i}" for i in range(5)),
        "framework/summarize_conversation", "framework/find_harvesting_limit",
    }
    assert all(call.metadata["govsim.phase"] and call.metadata["govsim.query"] for call in calls)
    assert not any("UnsupportedFieldAttributeWarning" in r["event"].get("line", "") for r in wire)
    assert not any("Defaults list is missing" in r["event"].get("line", "") for r in wire)
    assert calls
    assert not any(r.event.type == "run.status" for r in records)
    # Exact reserialization proves optional model nulls were omitted. Explicit
    # JSON nulls inside native rows and nullable parameters are evidence, retained.
    assert [r.model_dump(mode="json", exclude_none=True) for r in records] == wire
    raw_rows = json.loads((store.workspace / "govsim_storage" /
                           "fish_baseline_concurrent" / "log_env.json").read_text())
    assert [e.data.root for e in customs if e.kind in {"govsim.record", "govsim.harvest", "govsim.utterance", "govsim.summary", "govsim.resource_limit"}] == raw_rows
    storage = store.workspace / "govsim_storage" / "fish_baseline_concurrent"
    markers = [r for r in records if r.event.type == "custom" and r.event.kind == "govsim.upstream_log"]
    personas = sorted(path for path in storage.glob("persona_*") if path.is_dir())
    assert personas
    assert all((path / "nodes.json").is_file() for path in personas)
    assert [r.event.data.source for r in markers] == [
        "log_env.json", *(f"{path.name}/nodes.json" for path in personas),
    ]
    for marker in markers:
        data = marker.event.data
        raw = (storage / data.source).read_bytes()
        rows = json.loads(raw)
        assert data.bytes == len(raw)
        assert data.sha256 == hashlib.sha256(raw).hexdigest()
        assert data.records == len(rows)
        following = records[marker.seq + 1:marker.seq + 1 + data.records]
        if data.source == "log_env.json":
            assert [r.event.data.root for r in following] == rows
        else:
            persona = Path(data.source).parent.name
            assert all(r.event.kind == "govsim.memory" and r.event.data.persona == persona for r in following)
            assert [r.event.data.node.root for r in following] == rows
    assert records[0].event.params["reasoning_effort"] is None


def test_llm_call_wire_has_no_nulls(completed_run):
    _, wire = completed_run

    def no_null(value):
        assert value is not None
        if isinstance(value, dict):
            for child in value.values():
                no_null(child)
        elif isinstance(value, list):
            for child in value:
                no_null(child)

    calls = [r["event"] for r in wire if r["event"]["type"] == "llm.call"]
    assert calls
    for call in calls:
        no_null(call)


def test_full_run_has_no_secrets(completed_run):
    store, _ = completed_run
    assert_run_has_no_secrets(store.dir)
