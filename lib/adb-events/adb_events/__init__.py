"""adb-events: the standardized ADB event shapes, shared by the runner and Python
control planes so the wire vocabulary has one definition (docs/plan/events.md).

- `adb_events.emit` — typed emitters (validated construction → wire JSONL).
- models + `EVENT_MODELS` + `validate_event` — for ingestion validation.
- `json_schemas()` — the per-type JSON Schema, the cross-language contract.
"""

from __future__ import annotations

from typing import Any

import msgspec

from .models import (EVENT_MODELS, AgentEvent, Artifact, CapturedLine, Json,
                     LlmCall, LlmError, LlmRequest, LlmResponse, LlmUsage, Log,
                     Message, Metric, Scalar, Status, validate_event)

__all__ = [
    "EVENT_MODELS", "validate_event", "json_schemas", "Json", "Scalar",
    "Status", "Log", "CapturedLine", "Metric", "Message", "LlmCall", "LlmRequest",
    "LlmResponse", "LlmUsage", "LlmError", "AgentEvent", "Artifact",
]


def json_schemas() -> dict[str, Any]:
    """One JSON Schema per standardized event type — what `adb-emit schema` serves and
    any language's test suite validates against."""
    return {t: msgspec.json.schema(m) for t, m in EVENT_MODELS.items()}
