"""Event-vocabulary models — re-exported from adb-events, the single source of truth.

The shapes used to be defined here in pydantic; they now live once in `adb_events`
(msgspec) so the runner's ingestion lint, `adb-emit`, and every python experiment share
one definition (docs/plan/events.md). This module stays as the runner's import
site so `from .events_schema import validate_event` keeps working.
"""

from __future__ import annotations

from adb_events import (  # noqa: F401
    EVENT_MODELS,
    AgentEvent,
    Artifact,
    CapturedLine,
    LlmCall,
    LlmError,
    LlmRequest,
    LlmResponse,
    LlmUsage,
    Log,
    Message,
    Metric,
    Status,
    json_schemas,
    validate_event,
)
