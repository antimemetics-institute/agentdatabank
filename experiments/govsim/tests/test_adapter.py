import json
import os
from pathlib import Path
import subprocess
import sys

import numpy as np
import pandas as pd
import pytest
from pydantic import ValidationError

from govsim_adapter.main import EXPERIMENTS, Params
from govsim_adapter.metrics import compute_metrics, gini
from govsim_adapter.embedder import HashEmbedder


def params(**overrides):
    return dict(experiment="fish_baseline_concurrent", max_rounds=1,
                model="mock/model", embedder="hash", temperature=0.0,
                top_p=1.0, max_tokens=8000) | overrides


@pytest.mark.parametrize("override", [dict(max_rounds=-1), dict(max_tokens=0),
    dict(reasoning_effort="none"), dict(top_p=0), dict(top_p=1.1), dict(temperature=float("nan")),
    dict(embedder="other"), dict(experiment="fish_baseline_concurrent,seed=9")])
def test_invalid_params(override):
    with pytest.raises(ValidationError):
        Params(**params(**override))


def test_embedder_deterministic_normalized():
    a, b = HashEmbedder(), HashEmbedder()
    assert np.array_equal(a.embed("fish"), b.embed("fish"))
    assert np.linalg.norm(a.embed("fish")) == pytest.approx(1)
    assert not np.array_equal(a.embed("fish"), a.embed_retrieve("fish"))


def test_collapse_and_outsider_denominator():
    rows = [dict(action="harvesting", round=0, agent_id=i,
                 resource_collected=5, wanted_resource=11,
                 resource_in_pool_before_harvesting=100,
                 resource_in_pool_after_harvesting=75) for i in range(5)]
    result = compute_metrics(pd.DataFrame(rows), 12)
    assert result == dict(rounds=1, collapsed=False, survival_months=12,
                         total_harvest=25, gain_per_agent=5.0,
                         final_resource=75, equality=1.0, over_usage=1.0)
    for row in rows:
        row["resource_in_pool_after_harvesting"] = 4
    assert compute_metrics(pd.DataFrame(rows), 12)["survival_months"] == 1
    assert compute_metrics(pd.DataFrame(rows), 12)["collapsed"] is True
    assert gini(np.array([0, 0])) == 0


def test_backend_forwards_sampling_and_caps_tokens(monkeypatch, event_capture):
    from govsim_adapter.backend import ChatClientBackend
    backend = ChatClientBackend("mock/model", 42, temperature=0.2, max_tokens=64)
    # Replace transport only: exercise the real adapter and shared client's
    # generation policy without making any network request.
    captured = {}
    def transport(kw):
        captured.update(kw)
        return _reply("Answer: 5.")
    backend.client.is_mock = False
    backend.client._request = transport
    chat = [{"role": "user", "content": "test"},
            {"role": "assistant", "content": "Answer: "}]
    assert backend.request_api(chat, 0.9, 0.75, 8000) == "Answer: 5."
    assert captured["model"] == "model"
    assert captured["temperature"] == 0.2
    assert captured["top_p"] == 0.75
    assert captured["max_completion_tokens"] == 64
    assert captured["seed"] == 42
    assert captured["messages"][-1]["content"] == "Answer:"
    assert chat[-1]["content"] == "Answer: "
    assert backend.client.n_calls == 1
    assert event_capture.read()[0]["agent"] == "framework"


@pytest.mark.skipif(not os.environ.get("GOVSIM_UPSTREAM"), reason="requires pinned upstream checkout")
@pytest.mark.parametrize("name,query,agent", [
    ("John", "prompt_harvest", "persona_0"),
    ("framework", "prompt_summarize_conversation_in_one_sentence", "framework/summarize_conversation"),
    ("framework", "prompt_find_harvesting_limit_from_conversation", "framework/find_harvesting_limit"),
    ("framework", "prompt_text_to_triple", "framework/text_to_triple"),
])
def test_logger_attributes_queries_without_changing_api_request(monkeypatch, event_capture, name, query, agent):
    monkeypatch.syspath_prepend(os.environ["GOVSIM_UPSTREAM"])
    from simulation.utils import WandbLogger
    from govsim_adapter.backend import ChatClientBackend
    from govsim_adapter.logger import AdbLogger

    # Replace wandb work only: use the real logger hooks, backend and event emitter.
    monkeypatch.setattr(WandbLogger, "__init__", lambda *args, **kwargs: None)
    monkeypatch.setattr(WandbLogger, "get_agent_chain", lambda *args: None)
    monkeypatch.setattr(WandbLogger, "start_chain", lambda *args: None)
    backend = ChatClientBackend("mock/model", 42, mock_responder=lambda _: "5")
    logger = AdbLogger("test", {"experiment": {"personas": {
        "num": 1, "persona_0": {"name": "John"},
    }}}, backend=backend)
    logger.get_agent_chain(name, "phase")
    logger.start_chain(f"phase::{query}")
    backend.request_api([{"role": "user", "content": "test"}], 0, 1, 64)
    [event] = event_capture.read()
    assert event["agent"] == agent
    assert event["metadata"]["govsim.phase"] == "phase"
    assert event["metadata"]["govsim.query"] == query
    assert "metadata" not in event["call"]["request"]


@pytest.mark.parametrize("temperature,top_p,reasoning_effort", [
    (None, None, "low"), (None, 0.75, None), (0.2, None, None),
])
def test_backend_explicit_null_omits_upstream_sampling_defaults(
    temperature, top_p, reasoning_effort, event_capture,
):
    from govsim_adapter.backend import ChatClientBackend
    parsed = Params(**params(temperature=temperature, top_p=top_p,
                             reasoning_effort=reasoning_effort))
    backend = ChatClientBackend("mock/model", 42,
                                temperature=parsed.temperature,
                                top_p=parsed.top_p,
                                reasoning_effort=parsed.reasoning_effort,
                                max_tokens=64)
    captured = {}
    def transport(kw):
        captured.update(kw)
        return _reply("5")
    backend.client.is_mock = False
    backend.client._request = transport
    # Upstream select forces 0.0/1.0 even when the wrapper receives None.
    assert backend.request_api([{"role": "user", "content": "test"}], 0.0, 1.0, 8000) == "5"
    assert ("temperature" in captured) == (temperature is not None)
    assert ("top_p" in captured) == (top_p is not None)
    assert ("reasoning_effort" in captured) == (reasoning_effort is not None)
    if reasoning_effort is not None:
        assert captured["reasoning_effort"] == reasoning_effort
    assert captured["max_completion_tokens"] == 64


@pytest.mark.skipif(not os.environ.get("GOVSIM_UPSTREAM"), reason="requires pinned upstream checkout")
@pytest.mark.parametrize("experiment", EXPERIMENTS)
def test_upstream_mock_pipeline(tmp_path, experiment, event_capture):
    config = tmp_path / "params.json"
    config.write_text(json.dumps(params(experiment=experiment, temperature=None,
                                        top_p=None, reasoning_effort="low")))
    env = dict(os.environ, ADB_RUN_DIR=str(tmp_path), ADB_SEED=str(2**48 + 37),
               HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1")
    proc = subprocess.run([sys.executable, "-c", "from govsim_adapter.main import main; raise SystemExit(main())", str(config)],
                          cwd=tmp_path, env=env, text=True, capture_output=True, timeout=120)
    assert proc.returncode == 0, proc.stderr
    events = event_capture.read()
    metrics = {e["name"]: e["value"] for e in events if e["type"] == "result"}
    assert "status" not in metrics
    assert metrics["rounds"] == 1
    assert metrics["total_harvest"] == (20 if "outsider" in experiment else 25)
    assert metrics["equality"] == 1.0
    assert "model_calls" not in metrics
    calls = [e for e in events if e["type"] == "llm.call"]
    assert calls
    allowed_agents = {*(f"persona_{i}" for i in range(5)),
                      "framework/summarize_conversation", "framework/find_harvesting_limit",
                      "framework/text_to_triple"}
    assert {e["agent"] for e in calls} <= allowed_agents
    assert all(e["metadata"]["govsim.phase"] and e["metadata"]["govsim.query"] for e in calls)
    assert "UnsupportedFieldAttributeWarning" not in proc.stderr
    assert any(e["type"] == "custom" and e["kind"] == "govsim.state" for e in events)
    from omegaconf import OmegaConf
    config = OmegaConf.create(next(e["data"] for e in events if e.get("kind") == "govsim.config"))
    assert config.llm.temperature is None
    assert config.llm.top_p is None
    assert config.llm.reasoning_effort == "low"
    assert config.seed == 37
    assert config.llm.path == "mock/model"
    assert config.llm.backend == "adb-experiment.ChatClient"
    assert not any(e["type"] == "artifact" for e in events)
    assert not (tmp_path / "artifacts").exists()
    states = [e["data"] for e in events if e["type"] == "custom" and e["kind"] == "govsim.state"]
    assert len(states) == 1
    assert states[0]["round"] == 0
    assert states[0]["resource"] == metrics["final_resource"]
    source_rows = json.loads((tmp_path / "govsim_storage" / experiment / "log_env.json").read_text())
    assert [e["data"] for e in events if e.get("kind") in {"govsim.record", "govsim.harvest", "govsim.utterance", "govsim.summary", "govsim.resource_limit"}] == source_rows


@pytest.mark.skipif(not os.environ.get("GOVSIM_UPSTREAM"), reason="requires pinned upstream checkout")
@pytest.mark.parametrize("fail_simulation", [True, False])
def test_failed_run_retains_config_and_raw_log(tmp_path, event_capture, fail_simulation):
    config = tmp_path / "params.json"
    config.write_text(json.dumps(params()))
    # A broken checkpoint remains inspectable in the transcript, without artifacts.
    script = '''
import importlib
import os
import sys
from pathlib import Path
from govsim_adapter.main import main

# This fixture patches upstream before main() can add GOVSIM_UPSTREAM to sys.path.
sys.path.insert(0, os.environ["GOVSIM_UPSTREAM"])

def simulate(cfg, logger, wrappers, wrapper, embedder, storage):
    Path(storage, "log_env.json").write_text("unfinished checkpoint")
    persona = Path(storage, "persona_0")
    persona.mkdir()
    (persona / "nodes.json").write_text('[{"id":1,"description":"completed memory checkpoint"}]')
    if FAIL_SIMULATION:
        raise RuntimeError("simulation failed after checkpoint")

importlib.import_module("simulation.scenarios.fishing.run").run = simulate
raise SystemExit(main())
'''.replace("FAIL_SIMULATION", repr(fail_simulation))
    proc = subprocess.run(
        [sys.executable, "-c", script, str(config)], cwd=tmp_path,
        env=dict(os.environ, ADB_RUN_DIR=str(tmp_path), HF_HUB_OFFLINE="1",
                 TRANSFORMERS_OFFLINE="1"),
        text=True, capture_output=True, timeout=120,
    )
    assert proc.returncode == 1, proc.stderr
    events = event_capture.read()
    assert any(e.get("kind") == "govsim.config" for e in events), proc.stderr
    assert next(e["data"]["text"] for e in events if e.get("kind") == "govsim.unparsed_log") == "unfinished checkpoint"
    assert [e["data"]["source"] for e in events if e.get("kind") == "govsim.upstream_log"] == ["log_env.json", "persona_0/nodes.json"]
    assert next(e["data"] for e in events if e.get("kind") == "govsim.memory") == {
        "persona": "persona_0", "node": {"id": 1, "description": "completed memory checkpoint"},
    }
    assert not any(e["type"] == "artifact" for e in events)
    assert not any(e["type"] == "result" for e in events)
    if fail_simulation:
        assert "simulation failed after checkpoint" in proc.stderr


def test_missing_upstream_exits_nonzero_with_traceback(tmp_path, event_capture):
    config = tmp_path / "params.json"
    config.write_text(json.dumps(params()))
    env = dict(os.environ, ADB_RUN_DIR=str(tmp_path))
    env.pop("GOVSIM_UPSTREAM", None)
    proc = subprocess.run([sys.executable, "-c", "from govsim_adapter.main import main; raise SystemExit(main())", str(config)],
                          cwd=tmp_path, env=env, text=True, capture_output=True, timeout=30)
    assert proc.returncode != 0
    events = event_capture.read()
    assert not any(e["type"] == "result" and e["name"] == "status" for e in events)
    assert "GOVSIM_UPSTREAM is not set" in proc.stderr


def _reply(text):
    from openai.types.chat import ChatCompletion

    return ChatCompletion.model_validate(
        {
            "id": "test",
            "object": "chat.completion",
            "created": 0,
            "model": "test-model",
            "choices": [
                {
                    "index": 0,
                    "finish_reason": "stop",
                    "message": {"role": "assistant", "content": text},
                }
            ],
        }
    )


def test_ingested_discussion_keeps_row_rounds_without_boundary_events(event_capture, tmp_path):
    from adb_events import CustomEvent, parse_event
    from govsim_adapter.upstream import ingest_storage

    rows = [dict(action="utterance", round=round_, agent_id="a", utterance=text)
            for round_ in (0, 3) for text in ("Take two.", "Leave enough for tomorrow.")]
    rows.insert(0, {"action": "harvesting", "round": 0, "wanted_resource": 7,
                    "html_interactions": ["<b>original</b>"], "future_field": {"x": None}})
    rows.append({"action": "future_action", "round": 3, "value": 1.25})
    (tmp_path / "log_env.json").write_text(json.dumps(rows))
    assert ingest_storage(tmp_path) == rows
    events = event_capture.read()
    assert all(isinstance(parse_event(json.dumps(e)), CustomEvent) for e in events)
    assert [e["data"] for e in events if e["kind"] in {"govsim.record", "govsim.harvest", "govsim.utterance", "govsim.summary", "govsim.resource_limit"}] == rows
    assert events[0]["kind"] == "govsim.upstream_log"
    assert events[0]["data"]["source"] == "log_env.json"
    assert events[0]["data"]["records"] == len(rows)
    assert len(events) == len(rows) + 1
