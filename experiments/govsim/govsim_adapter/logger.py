"""AdbLogger — upstream's WandbLogger, neutralized and translated to ADB events.

Subclass, not fork (extend-tool-as-library): ``debug=True`` is forced, so
``wandb.init(mode="disabled")`` makes every trace/log upstream fires a no-op —
no network, no files. On top of that:

* ``get_agent_chain`` re-points the shared backend's ChatClient ``agent`` before
  delegating, so each ``llm.call`` event carries the persona (or ``framework``)
  it belongs to — one backend serves all personas, matching upstream's
  single-LLM shape.
* ``log_game`` (the per-step hook every scenario ``run()``/env already calls)
  accumulates the round's stats and emits one ``govsim.state`` event per round,
  and a chartable ``pool`` metric series.

Round boundaries are inferred from the stats stream itself: a
``conversation_resource_limit`` key closes the round (the restaurant phase), and
a repeated ``*_collected_resource`` key means a new round began — which covers
the no-language perturbation, whose phase cycle drops the restaurant step. The
pool reported for a round is the value observed alongside its last stats entry
(the post-harvest pool), not the post-doubling value the next round opens with.
"""

from __future__ import annotations

from adb_events import CustomEvent, Metric, emit
from simulation.utils import WandbLogger

_COLLECTED = "_collected_resource"
_LIMIT = "conversation_resource_limit"


class AdbLogger(WandbLogger):
    def __init__(self, experiment_name: str, config: dict, *, backend) -> None:
        super().__init__(experiment_name, config, debug=True)
        self._backend = backend
        self._round = 0
        self._pool: int | None = None  # pool observed with the round's stats
        self._collected: dict[str, int] = {}
        self._limit: int | None = None

    # -- llm.call attribution -------------------------------------------------

    def get_agent_chain(self, agent_name, phase_name):
        self._backend.client.agent = agent_name
        return super().get_agent_chain(agent_name, phase_name)

    # -- live progress --------------------------------------------------------

    def _flush(self, *, final: bool = False) -> None:
        emit(
            CustomEvent(
                kind="govsim.state",
                data={
                    "round": self._round,
                    "resource": self._pool,
                    "collected": self._collected,
                    "limit": self._limit,
                    "final": final,
                },
            )
        )
        if self._pool is not None:
            emit(Metric(name="pool", value=self._pool, step=self._round))
        self._round += 1
        self._collected = {}
        self._limit = None

    def log_game(self, kwargs, last_log=False):
        super().log_game(kwargs, last_log)
        stats = {k: v for k, v in kwargs.items() if k.endswith(_COLLECTED)}
        # a persona betting again = the next round started before this one was
        # closed by a restaurant phase — flush with the previous round's pool
        if any(key[: -len(_COLLECTED)] in self._collected for key in stats):
            self._flush()
        for key, value in stats.items():
            self._collected[key[: -len(_COLLECTED)]] = value
        # latch the pool alongside stats: the round's LAST stats-bearing step
        # observes the post-harvest pool (the survival-relevant series), never
        # the post-doubling value the next round opens with
        if stats or _LIMIT in kwargs:
            self._pool = kwargs.get("num_resource", self._pool)
        if _LIMIT in kwargs:
            self._limit = kwargs[_LIMIT]
            self._flush(final=last_log)
        elif last_log and self._collected:
            # A bare terminal notification after an already flushed round is
            # not another harvest. In particular, don't chart its regrown pool.
            self._flush(final=True)
