"""The public event vocabulary, its JSON schemas, and typed emission/read APIs."""

from typing import Any

# Load the core models before the vendored snapshot imports models.base.
from .models import (
    EVENT_ADAPTER,
    EVENT_MODELS,
    PRODUCER_ADAPTER,
    PRODUCER_MODELS,
    CapturedLine,
    CustomEvent,
    Envelope,
    Json,
    LLMCall,
    Log,
    Result,
    Payload,
    ProducerPayload,
    RunEnd,
    RunEnvironment,
    RunStart,
    Scalar,
    Status,
    validate_event,
)
from .inspect_chat import (
    ChatMessage,
    ChatMessageAssistant,
    ChatMessageSystem,
    ChatMessageTool,
    ChatMessageUser,
    ModelCall, ModelOutput, ModelUsage, ChatCompletionChoice, ToolInfo, ToolFunction,
)
from .emit import emit
from .transport import EventTransportError
from .read import EventReadError, parse_event, read_events
from .render import ActorRegistry, RenderHint, export_schema

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
    "RenderHint",
    "ActorRegistry",
    "export_schema",
    "Json",
    "Scalar",
    "Status",
    "Log",
    "CapturedLine",
    "Result",
    "LLMCall",
    "ChatMessage",
    "ChatMessageAssistant",
    "ChatMessageSystem",
    "ChatMessageTool",
    "ChatMessageUser",
    "ModelCall", "ModelOutput", "ModelUsage", "ChatCompletionChoice", "ToolInfo", "ToolFunction",
    "CustomEvent",
    "RunStart",
    "RunEnd",
    "RunEnvironment",
]


def json_schemas() -> dict[str, Any]:
    """Per-type schemas; EVENT_ADAPTER.json_schema() exports the complete union."""
    return {
        name: model.model_json_schema(by_alias=True)
        for name, model in EVENT_MODELS.items()
    }
