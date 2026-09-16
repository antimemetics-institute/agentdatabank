"""Model API boundary data in the ADB event vocabulary.

Based on Inspect AI 0.3.263, src/inspect_ai/event/_model.py and _base.py.
Nested vendored models and full provenance: ../inspect_chat.py.

Local changes: retain boundary fields; agent is the only ADB-added data field.
Drop role, retries, cache, config and its params/temperature/max_tokens projections.
Drop deferred ADB instance_id/repeat attribution. Generation settings stay in call.request.
Drop input_refs, traceback/traceback_ansi, pending, working_start, span_id, and
runtime helpers. The envelope owns identity and timestamp; type is llm.call.
"""

from typing import Any, Literal

from pydantic import Field

from ..inspect_chat import ChatMessage, ModelCall, ModelOutput, ToolChoice, ToolInfo
from .base import Event, UtcDatetime


class LLMCall(Event[Literal["llm.call"]]):
    type: Literal["llm.call"] = "llm.call"
    model: str
    input: list[ChatMessage]
    tools: list[ToolInfo] = Field(default_factory=list[ToolInfo])
    tool_choice: ToolChoice = "auto"
    output: ModelOutput
    call: ModelCall | None = None
    error: str | None = None
    completed: UtcDatetime | None = None
    working_time: float | None = None
    metadata: dict[str, Any] | None = None
    agent: str | None = None
