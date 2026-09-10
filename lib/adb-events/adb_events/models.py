"""Event models: strict authoring, open JSON metadata, and typed saved records.

Construct public models and pass them to emit(). Experiment-specific data uses
CustomEvent. Payload is the closed vocabulary shared by producers and readers.
The runner rejects invalid socket submissions and captures stdout as text.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Annotated, Any, Literal, get_args

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    JsonValue,
    TypeAdapter,
    ValidationError,
)

# Covariant containers for shared API annotations. Open wire objects below use
# dict[str, Any] because adapters pass provider-owned JSON with arbitrary shapes.
type Json = Mapping[str, "Json"] | Sequence["Json"] | str | int | float | bool | None
type Scalar = int | float | str | bool
NonNegativeInt = Annotated[int, Field(ge=0)]
NonNegativeNumber = Annotated[int | float, Field(ge=0)]


class Model(BaseModel):
    model_config = ConfigDict(
        strict=True,
        extra="forbid",
        populate_by_name=True,
        validate_assignment=True,
        revalidate_instances="always",
        allow_inf_nan=False,
    )


class _Event[EventType: str = str](Model):
    """Internal base for the closed set of public payload models."""

    type: EventType


class Status(_Event[Literal["status"]]):
    type: Literal["status"] = "status"
    detail: str


class Log(_Event[Literal["log"]]):
    type: Literal["log"] = "log"
    message: str
    level: Literal["debug", "info", "warn", "error"] = "info"


class CapturedLine(_Event[Literal["stdout", "stderr"]]):
    type: Literal["stdout", "stderr"]
    line: str
    meta: dict[str, Any] | None = None


class Metric(_Event[Literal["metric"]]):
    type: Literal["metric"] = "metric"
    name: str
    value: Scalar
    step: int | None = None
    unit: str | None = None


class Message(_Event[Literal["message"]]):
    type: Literal["message"] = "message"
    from_: str = Field(validation_alias="from", serialization_alias="from")
    content: str
    channel: str
    to: str | None = None
    visible_to: list[str] | None = None
    meta: dict[str, Any] | None = None


class LLMRequest(Model):
    messages: list[dict[str, Any]]
    # Effective SDK arguments after adapter overrides, excluding messages/model.
    params: dict[str, Any] = Field(default_factory=dict)
    model: str | None = None  # actual model argument sent to the SDK
    raw: dict[str, Any] | None = None  # provider request, when available


class LLMResponse(Model):
    message: dict[str, Any]
    finish_reason: str | None = None
    model: str | None = None  # provider-returned name; not proof of equivalence
    raw: dict[str, Any] | None = None  # full provider response, not just its message


class LLMUsage(Model):
    input_tokens: NonNegativeInt | None = None
    output_tokens: NonNegativeInt | None = None


class LLMError(Model):
    kind: str
    message: str


class LLMCall(_Event[Literal["llm.call"]]):
    type: Literal["llm.call"] = "llm.call"
    model: str  # experiment-requested provider/model identifier
    request: LLMRequest
    agent: str | None = None
    response: LLMResponse | None = None
    usage: LLMUsage | None = None
    latency_ms: NonNegativeNumber | None = None
    error: LLMError | None = None
    meta: dict[str, Any] | None = None


class AgentEvent(_Event[Literal["agent.event"]]):
    type: Literal["agent.event"] = "agent.event"
    agent: str
    kind: str
    data: dict[str, Any] = Field(default_factory=dict)


class InstanceData(Model):
    id: str | int
    repeat: Annotated[int, Field(ge=1)] | None = None
    scores: dict[str, Scalar] | None = None
    error: str | None = None
    target: Any = None
    meta: dict[str, Any] | None = None


class Instance(_Event[Literal["instance"]]):
    type: Literal["instance"] = "instance"
    agent: str
    data: InstanceData


class Artifact(_Event[Literal["artifact"]]):
    type: Literal["artifact"] = "artifact"
    name: str
    path: str
    media_type: str | None = None
    bytes: NonNegativeInt | None = None


class CustomEvent(_Event[Literal["custom"]]):
    """Experiment-specific observations within the public wire vocabulary."""

    type: Literal["custom"] = "custom"
    kind: str
    data: dict[str, JsonValue]


class RunEnvironment(Model):
    adb_runner: str
    platform: str
    experiment_bin: str
    runner_python: str
    runner_python_version: str
    # Supplied by the Nix launcher; absent for direct, unpackaged runner calls.
    runner_bin: str | None = None
    nix_system: str | None = None


class UsageTotals(Model):
    llm_calls: NonNegativeInt
    input_tokens: NonNegativeInt
    output_tokens: NonNegativeInt


class RunStart(_Event[Literal["run.start"]]):
    type: Literal["run.start"] = "run.start"
    condition: str
    experiment: str
    source: str
    fetch_ref: str
    dirty: bool
    spec_params: dict[str, Any]
    realized_params: dict[str, Any]
    base_seed: int
    replicates: Annotated[int, Field(ge=1)]
    seed: NonNegativeInt
    replicate: Annotated[int, Field(ge=1)]
    env: RunEnvironment
    result_definitions: dict[str, Any]


class RunStatus(_Event[Literal["run.status"]]):
    type: Literal["run.status"] = "run.status"
    state: Literal["provisioning", "running", "completed", "failed", "interrupted"]


class RunEnd(_Event[Literal["run.end"]]):
    type: Literal["run.end"] = "run.end"
    state: Literal["completed", "failed", "interrupted"]
    duration_s: NonNegativeNumber
    summary: dict[str, Scalar]
    usage_totals: UsageTotals
    exit_code: int


# These unions are the authority. The registry used for per-type schema export
# is derived from their literal tags, rather than maintaining a second list.
type ProducerPayload = Annotated[
    Status
    | Log
    | CapturedLine
    | Metric
    | Message
    | LLMCall
    | AgentEvent
    | Instance
    | Artifact
    | CustomEvent,
    Field(discriminator="type"),
]
type Payload = Annotated[
    ProducerPayload | RunStart | RunStatus | RunEnd,
    Field(discriminator="type"),
]
PRODUCER_ADAPTER = TypeAdapter[ProducerPayload](ProducerPayload)
EVENT_ADAPTER = TypeAdapter[Payload](Payload)


def _event_models(annotation: Any) -> dict[str, type[_Event[Any]]]:
    from typing import TypeAliasType

    if isinstance(annotation, TypeAliasType):
        return _event_models(annotation.__value__)
    if isinstance(annotation, type) and issubclass(annotation, _Event):
        return {
            tag: annotation
            for tag in get_args(annotation.model_fields["type"].annotation)
        }
    models: dict[str, type[_Event[Any]]] = {}
    for arg in get_args(annotation):
        models.update(_event_models(arg))
    return models


EVENT_MODELS = _event_models(Payload)
PRODUCER_MODELS = _event_models(ProducerPayload)


class Envelope(Model):
    """A saved record with a conformant payload."""

    v: Literal[0] = 0
    ts: str
    run: str
    seq: NonNegativeInt
    event: Payload


def validate_event(payload: Mapping[str, Any]) -> list[str]:
    """Validate the public vocabulary without modifying the original payload."""
    try:
        EVENT_ADAPTER.validate_python(dict(payload), strict=True)
    except ValidationError as exc:
        return [str(exc)]
    return []
