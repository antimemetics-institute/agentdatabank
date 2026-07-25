"""concordia: run one Concordia generative-agent simulation and translate it to ADB events.

    concordia-sim CONFIG.json

One run = one Concordia `Simulation.play()`, assembled exactly as upstream's tutorial
notebook does it: prefabs + instances + Config + Simulation + play. Everything beyond
that assembly lives at the edges — params in (models.py), the instrumented model client
(client.py), the transcript out (translate.py). A plain program: no ADB imports beyond
the event vocabulary; failure at any stage is data — the run finishes with a zeroed
summary and exit 0, never crashes.
"""

from __future__ import annotations

import hashlib
import platform
import random
import sys
import traceback
from importlib.metadata import version

import numpy as np

from adb_events.emit import log, status
from adb_experiment import deposit_artifact, experiment_main, protected_stream
from .models import Params
from .translate import (GM_NAME, TurnEmitter, emit_provenance, emit_scene,
                        emit_summary)


def make_embedder():
    """A deterministic hash -> unit-vector embedder for Concordia's associative memory.
    Avoids pulling sentence-transformers/torch; retrieval is arbitrary but stable, which
    is all a smoke-scale simulation needs."""

    def embed(text: str) -> np.ndarray:
        digest = hashlib.sha256(text.encode("utf-8")).digest()
        rng = np.random.default_rng(int.from_bytes(digest[:8], "big"))
        vec = rng.standard_normal(64)
        norm = np.linalg.norm(vec)
        return vec / norm if norm else vec

    return embed


def build_simulation(params: Params):
    """The upstream tutorial's assembly, param-driven. Imported lazily so a bad config
    is reported before the heavy Concordia import chain runs. The one non-tutorial
    ingredient is a model client per entity — that's what attributes each llm.call
    event to its agent (client.PerEntitySimulation)."""
    import importlib

    from concordia.prefabs.entity import conversational
    from concordia.typing import prefab as prefab_lib

    from .client import AdbLanguageModel, PerEntitySimulation

    # the game master is any prefab under concordia.prefabs.game_master, imported by
    # name. dialogic is a pure conversation: it hands control back to itself and cannot
    # end the scene; fixed acting order keeps turn-taking deterministic. Params a GM
    # doesn't use are ignored (prefabs read via .get), so this is safe across GMs.
    gm_module = importlib.import_module(
        f"concordia.prefabs.game_master.{params.game_master}"
    )
    gm_params: dict = {"name": GM_NAME, "acting_order": "fixed"}
    if params.game_master == "dialogic":
        gm_params |= {"next_game_master_name": GM_NAME,
                      "can_terminate_simulation": False}

    prefabs = {
        "conversational__Entity": conversational.Entity(),
        "game_master": gm_module.GameMaster(),
    }
    instances = [
        prefab_lib.InstanceConfig(
            prefab="conversational__Entity",
            role=prefab_lib.Role.ENTITY,
            params={"name": agent.name, "goal": agent.goal},
        )
        for agent in params.agents
    ] + [
        prefab_lib.InstanceConfig(
            prefab="game_master",
            role=prefab_lib.Role.GAME_MASTER,
            params=gm_params,
        )
    ]
    config = prefab_lib.Config(
        prefabs=prefabs,
        instances=instances,
        default_premise=params.premise,
        default_max_steps=params.max_steps,
    )

    clients = {
        agent.name: AdbLanguageModel(params, model=agent.model or None, agent=agent.name)
        for agent in params.agents
    }
    clients[GM_NAME] = AdbLanguageModel(params, agent=GM_NAME)
    sim = PerEntitySimulation(
        config=config, model=clients[GM_NAME], embedder=make_embedder(),
        clients=clients,
    )
    return sim, list(clients.values())


def run(params: Params) -> None:
    # Concordia reaches for unseeded global RNG (numpy + random) in a few places; seed
    # both so replicates don't share RNG state. (Full byte-reproducibility isn't
    # promised: the engine fans component calls over a thread pool, so memory-accrual
    # order — and with it prompt contents — can vary run to run.)
    random.seed(params.seed)
    np.random.seed(params.seed & 0xFFFFFFFF)

    emit_provenance(
        concordia_version=version("gdm-concordia"),
        model=params.default_model,
        agents=len(params.agents),
        python_version=platform.python_version(),
    )
    sim, clients = build_simulation(params)
    turns = TurnEmitter({agent.name for agent in params.agents})
    status(f"running concordia: default_model={params.default_model} "
           f"agents={len(params.agents)} max_steps={params.max_steps}")

    scene = emit_scene(params.premise)  # the opening, streamed first
    failure = None
    try:
        # Concordia's engine prints its narration to stdout — our JSONL channel —
        # so play() runs under the protected stream (events live, prints dropped)
        with protected_stream():
            sim_log = sim.play(premise=params.premise, max_steps=params.max_steps,
                               raw_log=turns.raw_log, step_callback=turns.step)
        # Concordia's own log viewer — memories, per-component reasoning, the works —
        # deposited verbatim; the event stream stays the semantic tier + llm.calls
        deposit_artifact("concordia log", sim_log.to_html(),
                         filename="concordia_log.html", media_type="text/html")
    except Exception as exc:  # a simulation that fails mid-run is data, not a crash
        failure = exc
    finally:
        turns.drain()  # semantic events from entries appended after the last callback

    if failure is not None:
        log(f"concordia simulation failed: {failure}", level="error")
        traceback.print_exception(failure)  # to stderr; the real traceback
    summary = emit_summary(
        status_str="error" if failure is not None else "completed",
        steps=turns.steps,
        agents=len(params.agents),
        world_events=scene + turns.world_events,
        model_calls=sum(c.n_calls for c in clients),
    )
    status(f"done: status={summary['status']} steps={summary['steps']} "
           f"world_events={summary['world_events']} model_calls={summary['model_calls']}")


def main() -> int:
    return experiment_main(
        Params, run, prog="concordia-sim", description=__doc__,
        fallback_summary={"status": "error", "steps": 0, "agents": 0,
                          "world_events": 0, "model_calls": 0},
    )


if __name__ == "__main__":
    sys.exit(main())
