"""Typed params (pydantic) — the boundary where config becomes structure.

Everything the Inspect run needs arrives as explicit values: which task, which
model, task/model args, and the usual sample/generation limits. This program is
repo-unaware — it maps these onto `inspect_ai.eval(...)` and translates the
resulting EvalLog into ADB events (docs/plan/experiments/inspect.md).
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field


class Params(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # the Inspect task to run: a registry id, a file
    # path (`path/to/file.py@task_fn`), or `pkg:<module>:<attr>` for a @task callable
    # from an installed package (how families select their task).
    task: str = Field(min_length=1)
    # Inspect model id (provider/model). `mockllm/model` runs keyless & offline. A
    # self-hosted / OpenAI-compatible server (Ollama, vLLM, …) is selected by the
    # provider's base-URL env var (OPENAI_BASE_URL for `openai/…`), NOT a param —
    # where a model is served is environment, not part of the experimental condition.
    model: str = "mockllm/model"
    # `-T` task args (types.object → a real dict), e.g. {"cot": true}.
    task_args: dict = Field(default_factory=dict)
    # `-M` model args (provider client kwargs).
    model_args: dict = Field(default_factory=dict)
    # generation config overrides, passed to Inspect's generate config,
    # e.g. {"temperature": 0.7, "max_tokens": 1024}.
    generate_args: dict = Field(default_factory=dict)
    # sample cap (0 = all).
    limit: int = Field(default=0, ge=0)
    # repeats of the dataset (1 = one pass).
    epochs: int = Field(default=1, ge=1)
    # provider connection cap (0 = Inspect default).
    max_connections: int = Field(default=0, ge=0)
    # per-sample message cap (0 = none).
    message_limit: int = Field(default=0, ge=0)
    # per-sample token cap (0 = none).
    token_limit: int = Field(default=0, ge=0)
    # forwarded to Inspect's generate config as `seed` (arrives via $ADB_SEED).
    seed: int = 0
