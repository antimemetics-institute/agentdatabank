"""govsim — GovSim ("Cooperate or Collapse", Piatti et al., NeurIPS 2024) as an
ADB experiment.

Five LLM personas share a common-pool resource (fishery / pasture / river):
each month they harvest concurrently, observe each other's catch, negotiate at
the restaurant, and reflect at home; the pool regrows doubling-capped, and the
commons collapses when it drops below 5. Upstream code runs verbatim from a
pinned checkout (``GOVSIM_UPSTREAM``, exported by the package.nix wrapper); this
program mirrors upstream ``simulation/main.py``'s construction site — config
composition, model injection, embedder substitution, wandb neutralization —
and extracts the paper's metrics from the persisted ``log_env.json``.

The program speaks the runner protocol (adb-experiment packages it): params
arrive as JSON on stdin (or a config path on argv for hand-runs), events leave
as JSON over the event socket. Any params or results change here must be mirrored in
package.nix.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Literal

from adb_events import Metric, Status, emit
from adb_experiment.scaffold import deposit_artifact, experiment_main
from pydantic import BaseModel, Field, field_validator


EXPERIMENTS = (
    "fish_baseline_concurrent",
    "fish_baseline_concurrent_paraphrase_1",
    "fish_baseline_concurrent_paraphrase_2",
    "fish_baseline_concurrent_universalization",
    "fish_perturbation_no_language",
    "fish_perturbation_outsider",
    "fish_perturbation_outsider_universalization",
    "sheep_baseline_concurrent",
    "sheep_baseline_concurrent_universalization",
    "sheep_perturbation_no_language",
    "sheep_perturbation_outsider",
    "sheep_perturbation_outsider_universalization",
    "pollution_baseline_concurrent",
    "pollution_baseline_concurrent_universalization",
    "pollution_perturbation_no_language",
    "pollution_perturbation_outsider",
    "pollution_perturbation_outsider_universalization",
)


class Params(BaseModel):
    experiment: str    # upstream experiment config id (the condition)
    max_rounds: int = Field(ge=0)  # 0 = upstream per-experiment value
    model: str         # provider/model; mock/model = keyless offline
    embedder: Literal["hash", "mxbai"]      # hash | mxbai
    temperature: float | None = Field(ge=0, allow_inf_nan=False)
    top_p: float | None = Field(gt=0, le=1, allow_inf_nan=False)
    max_tokens: int = Field(gt=0)
    reasoning_effort: Literal["low", "medium", "high", "xhigh", "max"] | None = None

    @field_validator("experiment")
    @classmethod
    def known_experiment(cls, value: str) -> str:
        if value not in EXPERIMENTS:
            raise ValueError("unknown GovSim experiment")
        return value


def _upstream_root() -> str:
    root = os.environ.get("GOVSIM_UPSTREAM")
    if not root:
        raise RuntimeError(
            "GOVSIM_UPSTREAM is not set — run via the package.nix wrapper "
            "(it exports the pinned upstream checkout and puts it on PYTHONPATH)"
        )
    return root


def _compose(root: str, params: Params, seed: int):
    """Hydra compose over the verbatim upstream conf tree. Absolute searchpath
    entries replace upstream's cwd-relative ones (no chdir needed); compose
    strips the hydra node, so upstream's ``${uuid:}`` run-dir resolver is never
    consulted."""
    from hydra import compose, initialize_config_dir

    searchpath = ",".join(
        f"{root}/simulation/scenarios/{s}/conf"
        for s in ("fishing", "sheep", "pollution")
    )
    overrides = [
        f"hydra.searchpath=[{searchpath}]",
        f"experiment={params.experiment}",
        "llm.is_api=true",
        f"+llm.reasoning_effort={json.dumps(params.reasoning_effort)}",
        f"llm.temperature={json.dumps(params.temperature)}",
        f"llm.top_p={json.dumps(params.top_p)}",
        f"seed={seed}",
        "debug=true",
    ]
    if params.max_rounds > 0:
        overrides.append(f"experiment.env.max_num_rounds={params.max_rounds}")
    with initialize_config_dir(config_dir=f"{root}/simulation/conf",
                               version_base=None):
        return compose("config", overrides=overrides)


def run(params: Params) -> None:
    # the runner derives wide per-replicate seeds; numpy's global RNG (via
    # transformers.set_seed, mirrored from upstream) only takes 32 bits — mask
    # once and use the same value everywhere (cfg.seed, RNGs, ChatClient)
    seed = int(os.environ.get("ADB_SEED", "0")) & 0xFFFFFFFF
    # belt and braces on top of AdbLogger's debug=True: wandb must never leave
    # the run dir or touch the network — set before simulation.utils imports it
    os.environ.setdefault("WANDB_MODE", "disabled")
    os.environ.setdefault("WANDB_DIR", os.getcwd())

    root = _upstream_root()
    if root not in sys.path:
        sys.path.insert(0, root)

    cfg = _compose(root, params, seed)
    # The composed upstream model path is bypassed by our injected backend.
    # Save the effective model in its place and describe all adapter choices.
    cfg.llm.path = params.model
    cfg.llm.backend = "adb-experiment.ChatClient"
    provenance = {
        "govsim_revision": "1d11adf047b24fa2ba0d44a1d4931015ea2e5210",
        "pathfinder_revision": "69b8d646ad3e618380dd0d47ec4d1e8d2d4c930e",
        "imported_adapter_revision": "f3b028b14bce693c69936544685bf199f9f4f71d",
        "effective_parameters": params.model_dump(),
        "effective_seed_32bit": seed,
        "backend": "mock" if params.model.startswith("mock/") else "openai-chat",
        "embedding_model": "sha256-normalized-1024" if params.embedder == "hash"
            else "mixedbread-ai/mxbai-embed-large-v1",
        "embedding_revision": None,
        "embedding_revision_note": "Hash algorithm is versioned with adapter code" if params.embedder == "hash"
            else "Upstream EmbeddingModel does not pin a HuggingFace revision; weights are mutable",
        "transcript_timestamps": "post-run replay time; order follows log_env.json",
    }
    deposit_artifact("provenance", json.dumps(provenance, indent=2),
                     filename="provenance.json", media_type="application/json")

    from omegaconf import OmegaConf
    from transformers import set_seed

    set_seed(seed)  # mirrored from upstream main.py (global python/numpy/torch)

    # model: our pathfinder backend, wrapped in the upstream wrapper — never
    # pathfinder.get_model (its name-substring dispatch rejects ADB model ids).
    # Single-LLM only: upstream's mix_llm path is broken at these pins.
    from .backend import ChatClientBackend
    from .embedder import make_embedder
    from .mock import govsim_mock_responder

    backend = ChatClientBackend(
        params.model,
        seed,
        temperature=params.temperature,
        top_p=params.top_p,
        reasoning_effort=params.reasoning_effort,
        max_tokens=params.max_tokens,
        mock_responder=govsim_mock_responder,  # only consulted on mock/
    )

    from .logger import AdbLogger  # imports simulation.utils (wandb) — after env vars

    logger = AdbLogger(str(cfg.experiment.name), OmegaConf.to_object(cfg),
                       backend=backend)

    from simulation.utils import ModelWandbWrapper

    wrapper = ModelWandbWrapper(
        backend,
        render=False,
        wanbd_logger=logger,
        temperature=params.temperature,
        top_p=params.top_p,
        seed=seed,
        is_api=True,
    )
    wrappers = [wrapper] * cfg.experiment.personas.num
    embedding_model = make_embedder(params.embedder)

    # upstream writes results inside its package dir (read-only in the store);
    # ours land in the run's workspace (the cwd the runner gives us)
    storage = os.path.abspath(os.path.join("govsim_storage", params.experiment))
    os.makedirs(storage, exist_ok=True)

    from simulation.scenarios.fishing.run import run as run_fishing
    from simulation.scenarios.pollution.run import run as run_pollution
    from simulation.scenarios.sheep.run import run as run_sheep

    scenarios = {
        "fishing": run_fishing,
        "sheep": run_sheep,
        "pollution": run_pollution,
    }
    scenario = str(cfg.experiment.scenario)  # a declared field, never inferred
    if scenario not in scenarios:
        raise ValueError(f"unknown experiment.scenario: {scenario}")

    emit(Status(detail=f"starting {params.experiment} ({scenario}) on {params.model}"))
    scenarios[scenario](
        cfg.experiment, logger, wrappers, wrapper, embedding_model, storage,
    )

    # post-run: the paper's record -> results, transcript, artifacts
    import pandas as pd

    from .metrics import compute_metrics, replay_transcript

    log_env_path = Path(storage) / "log_env.json"
    df = pd.read_json(log_env_path)
    results = compute_metrics(df, int(cfg.experiment.env.max_num_rounds))
    replay_transcript(df)

    deposit_artifact("log_env", log_env_path.read_text(),
                     filename="log_env.json", media_type="application/json")
    deposit_artifact("config", OmegaConf.to_yaml(cfg),
                     filename="config.yaml", media_type="application/yaml")

    for name, value in results.items():
        emit(Metric(name=name, value=value))
    emit(Metric(name="model_calls", value=backend.client.n_calls))


def main() -> int:
    return experiment_main(Params, run, prog="govsim")
