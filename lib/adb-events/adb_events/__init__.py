"""The public event vocabulary, its JSON schemas, and typed emission/read APIs."""

from typing import Any

from .emit import emit
from .models import (
    EVENT_ADAPTER,
    EVENT_MODELS,
    PRODUCER_ADAPTER,
    PRODUCER_MODELS,
    AgentEvent,
    Artifact,
    CapturedLine,
    CustomEvent,
    Envelope,
    Instance,
    InstanceData,
    Json,
    LLMCall,
    LLMError,
    LLMRequest,
    LLMResponse,
    LLMUsage,
    Log,
    Message,
    Metric,
    Payload,
    ProducerPayload,
    RunEnd,
    RunEnvironment,
    RunStart,
    RunStatus,
    Scalar,
    Status,
    UsageTotals,
    validate_event,
)
from .transport import EventTransportError
from .read import EventReadError, parse_event, read_events

__all__ = [
    "emit",
    "parse_event",
    "read_events",
    "EventReadError",
    "EventTransportError",
    "Payload",
    "ProducerPayload",
    "Envelope",
    "EVENT_ADAPTER",
    "EVENT_MODELS",
    "PRODUCER_ADAPTER",
    "PRODUCER_MODELS",
    "validate_event",
    "json_schemas",
    "Json",
    "Scalar",
    "Status",
    "Log",
    "CapturedLine",
    "Metric",
    "Message",
    "LLMCall",
    "LLMRequest",
    "LLMResponse",
    "LLMUsage",
    "LLMError",
    "AgentEvent",
    "Instance",
    "InstanceData",
    "Artifact",
    "CustomEvent",
    "RunStart",
    "RunStatus",
    "RunEnd",
    "RunEnvironment",
    "UsageTotals",
]


def json_schemas() -> dict[str, Any]:
    """Per-type schemas; EVENT_ADAPTER.json_schema() exports the complete union."""
    return {
        name: model.model_json_schema(by_alias=True)
        for name, model in EVENT_MODELS.items()
    }
