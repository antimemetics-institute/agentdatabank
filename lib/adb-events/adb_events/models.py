"""The event payload vocabulary as msgspec Structs (docs/plan/specs/events.md).

These model *payloads* — the `event` value inside the runner-owned transport envelope
`{v, ts, run, seq, event}`. Single source of truth for the standardized shapes: the
runner imports them for ingestion validation and `adb-emit schema`, and Python control
planes import them (via `adb_events.emit`) so a malformed `llm.call`/`message`/… is
impossible to construct. Experiments may still emit ANY json — `type` is optional, and
unknown or absent types are legal and preserved (the spec's conformance ladder); these
are the shapes that get first-class rendering and cross-experiment comparison.

msgspec (not pydantic) on purpose: this is the package every experiment pins, so a
single zero-dependency C extension keeps that closure minimal. Unknown fields are
ignored on validation (msgspec's default), so extension fields never fail the check —
the raw line is what gets stored, and extension emission goes through `emit.emit_raw`.
"""

from __future__ import annotations

from typing import Literal, Union

import msgspec


class Status(msgspec.Struct, omit_defaults=True):
    detail: str


class Log(msgspec.Struct, omit_defaults=True):
    """A deliberate, structured emission. Captured process output is CapturedLine
    (`stdout`/`stderr`), which never gets an invented level."""
    message: str
    level: Literal["debug", "info", "warn", "error"] = "info"


class CapturedLine(msgspec.Struct, omit_defaults=True):
    """`stdout`/`stderr` payload: one line of captured process output that wasn't an
    event payload — runner-synthesized, verbatim, untruncated."""
    line: str


class Metric(msgspec.Struct, omit_defaults=True):
    name: str
    value: Union[int, float, str, bool]
    step: Union[int, None] = None
    unit: Union[str, None] = None


class Message(msgspec.Struct, rename={"from_": "from"}, omit_defaults=True):
    from_: str
    content: str
    channel: str
    to: Union[str, None] = None
    visible_to: Union[list[str], None] = None
    meta: Union[dict, None] = None


class LlmRequest(msgspec.Struct, omit_defaults=True):
    messages: list[dict]
    params: dict = msgspec.field(default_factory=dict)


class LlmResponse(msgspec.Struct, omit_defaults=True):
    message: dict
    finish_reason: Union[str, None] = None
    # the provider-echoed RESOLVED model id, when the wrapper can see it — distinct
    # from LlmCall.model (the REQUESTED id): a run naming a moving alias records
    # here what the alias resolved to at the moment of use (a comparability
    # covariate that cannot be backfilled)
    model: Union[str, None] = None
    raw: Union[dict, None] = None


class LlmUsage(msgspec.Struct, omit_defaults=True):
    input_tokens: Union[int, None] = None
    output_tokens: Union[int, None] = None


class LlmError(msgspec.Struct, omit_defaults=True):
    kind: str
    message: str


class LlmCall(msgspec.Struct, omit_defaults=True):
    model: str
    request: LlmRequest
    agent: Union[str, None] = None
    response: Union[LlmResponse, None] = None
    usage: Union[LlmUsage, None] = None
    latency_ms: Union[int, float, None] = None
    error: Union[LlmError, None] = None
    # what the call served (like Message.meta) — e.g. sample_id/epoch when one run
    # works through many problems, so calls stay attributable under interleaving
    meta: Union[dict, None] = None


class AgentEvent(msgspec.Struct, omit_defaults=True):
    agent: str
    kind: str
    data: dict = msgspec.field(default_factory=dict)


class Artifact(msgspec.Struct, omit_defaults=True):
    name: str
    path: str
    media_type: Union[str, None] = None
    bytes: Union[int, None] = None


# payload `type` on the wire → Struct
EVENT_MODELS: dict[str, type[msgspec.Struct]] = {
    "status": Status,
    "log": Log,
    "stdout": CapturedLine,
    "stderr": CapturedLine,
    "metric": Metric,
    "message": Message,
    "llm.call": LlmCall,
    "agent.event": AgentEvent,
    "artifact": Artifact,
}


def validate_event(payload: dict) -> list[str]:
    """Errors for a known-type payload dict; empty list = valid or unknown/absent type
    (both legal by spec — the conformance ladder). Unknown *fields* are allowed."""
    model = EVENT_MODELS.get(payload.get("type") or "")
    if model is None:
        return []
    body = {k: v for k, v in payload.items() if k != "type"}
    try:
        msgspec.convert(body, model)
        return []
    except msgspec.ValidationError as exc:
        return [str(exc)]
