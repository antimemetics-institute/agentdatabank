"""Typed emitters — validate the payload, then print the wire JSON line.

Drop-in for the ~30-line shim experiments used to vendor, but the construction is
validated: EVERY typed emitter goes through msgspec.convert, so a wrong-shaped
`metric`/`message`/`llm.call`/… raises here (loudly, in the experiment, caught by
its tests) instead of slipping out and being linted malformed by the runner
(docs/plan/events.md, producer validation). Non-standard events go through
`emit_raw` — the deliberate escape hatch: any JSON, no checks.
"""

from __future__ import annotations

import sys
import threading
from typing import TextIO

import msgspec

from .models import (AgentEvent, Artifact, Json, LlmCall, Log, Message, Metric,
                     Scalar, Status)

_encode = msgspec.json.encode

# Where events go. None => sys.stdout, resolved per call (the default; back-compat).
# An experiment that must silence a noisy in-process subprocess by swapping sys.stdout
# (e.g. Concordia's verbose engine) can point events at a saved real-stdout handle with
# set_output() so they keep streaming live instead of being buffered.
_output: TextIO | None = None


def set_output(stream: TextIO | None) -> None:
    """Send subsequent events to `stream` (pass None to restore sys.stdout)."""
    global _output
    _output = stream


# One event = one intact line, even when an experiment emits from worker threads
# (e.g. Concordia's engine fans component calls out over a thread pool).
_write_lock = threading.Lock()


def _write(obj: dict[str, Json]) -> None:
    # decode to str and write via the text stream, so this works with any stdout —
    # a pipe (the runner), pytest's capsys, or a redirected StringIO
    out = sys.stdout if _output is None else _output
    line = _encode(obj).decode("utf-8") + "\n"
    with _write_lock:
        out.write(line)
        out.flush()


def _emit(type_: str, struct: msgspec.Struct) -> None:
    # encode→decode applies the struct's field renames (e.g. from_→from); splice in type
    body = msgspec.json.decode(_encode(struct))
    _write({"type": type_, **body})


def _validated(type_: str, model: type[msgspec.Struct], body: dict[str, Json]) -> None:
    """Validate a wire-shaped payload dict against its Struct, then emit it. This is
    what makes a malformed typed payload impossible to *emit* (msgspec Structs don't
    type-check plain construction — validation only happens through convert)."""
    try:
        _emit(type_, msgspec.convert(body, model))
    except msgspec.ValidationError as exc:
        raise TypeError(f"invalid {type_} event: {exc}") from None


def emit_raw(type_: str, **fields: Json) -> None:
    """Emit an arbitrary event verbatim — the escape hatch for experiment-specific
    types (or extension fields) the standard shapes don't cover (preserved by
    consumers per the spec). Deliberately unvalidated: any JSON is legal here."""
    _write({"type": type_, **fields})


def status(detail: str) -> None:
    _validated("status", Status, {"detail": detail})


def log(message: str, *, level: str = "info") -> None:
    _validated("log", Log, {"message": message, "level": level})


# Every emitter with more than one field is fully keyword-only: same-typed payload
# args (which string is the channel? name or value first?) make positional calls a
# silent-swap hazard, and consumers shouldn't need per-function rules. Only a lone
# required payload (status/log/emit_raw's first arg) may be positional.
def metric(*, name: str, value: Scalar, step: int | None = None, unit: str | None = None) -> None:
    # a structured value raises at runtime too (Metric.value is Scalar) — flatten to
    # multiple '/'-joined names instead (docs/plan/events.md)
    _validated("metric", Metric, {"name": name, "value": value, "step": step, "unit": unit})


def message(*, from_: str, content: str, channel: str, to: str | None = None,
            visible_to: list[str] | None = None, **meta: Json) -> None:
    _validated("message", Message, {"from": from_, "content": content, "channel": channel,
                                    "to": to, "visible_to": visible_to, "meta": meta or None})


def llm_call(*, agent: str | None, model: str, request: dict[str, Json],
             response: dict[str, Json] | None = None,
             usage: dict[str, Json] | None = None,
             latency_ms: int | float | None = None,
             error: dict[str, Json] | None = None,
             **meta: Json) -> None:
    _validated("llm.call", LlmCall, {
        "agent": agent, "model": model, "request": request,
        "response": response, "usage": usage, "latency_ms": latency_ms, "error": error,
        "meta": meta or None,
    })


def agent_event(*, agent: str, kind: str, **data: Json) -> None:
    _validated("agent.event", AgentEvent, {"agent": agent, "kind": kind, "data": data})


_SCALAR = (int, float, str, bool)


def instance(*, agent: str, id: str | int, scores: dict[str, Scalar] | None = None,
             repeat: int | None = None, error: str | None = None, **data: Json) -> None:
    """Close out one instance — the multi-instance run convention
    (docs/plan/events.md): one run working through many independent units (dataset
    rows, swebench instances, arena matches). `scores` is a FLAT scalar map;
    structured scorers flatten at emit with '/'-joined names
    ({"combined_scorer/refusal": 1}). `repeat` is the 1-based within-run repeat of
    this instance (distinct from the run-level replicate). Extra kwargs ride along
    in data untyped (target, domain fields)."""
    if isinstance(id, bool) or not isinstance(id, (str, int)):
        raise TypeError(f"instance id must be str or int, got {type(id).__name__}")
    for k, v in (scores or {}).items():
        if not isinstance(v, _SCALAR):
            raise TypeError(
                f"instance score {k!r} must be a scalar (int/float/str/bool), got "
                f"{type(v).__name__} — flatten structured scorers with '/'-joined names")
    # validated fields last, so they win over anything riding in via **data
    body = {**data, "id": id}
    if repeat is not None:
        body["repeat"] = repeat
    if scores is not None:
        body["scores"] = scores
    if error is not None:
        body["error"] = error
    agent_event(agent=agent, kind="instance", **body)


def artifact(*, name: str, path: str, media_type: str | None = None,
             size: int | None = None) -> None:
    _validated("artifact", Artifact, {"name": name, "path": path,
                                      "media_type": media_type, "bytes": size})
