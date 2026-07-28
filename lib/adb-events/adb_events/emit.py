"""Typed emitters — construct a validated Struct, then print the wire JSON line.

Drop-in for the ~30-line shim experiments used to vendor, but the construction is
validated: a wrong-shaped `llm.call`/`message`/… raises here (loudly, in the
experiment, caught by its tests) instead of slipping out and being linted malformed by
the runner. Non-standard events go through `emit_raw` (unknown types are legal).
"""

from __future__ import annotations

import sys
import threading
from typing import Any

import msgspec

from .models import (AgentEvent, Artifact, LlmCall, Log, Message, Metric, Status)

_encode = msgspec.json.encode

# Where events go. None => sys.stdout, resolved per call (the default; back-compat).
# An experiment that must silence a noisy in-process subprocess by swapping sys.stdout
# (e.g. Concordia's verbose engine) can point events at a saved real-stdout handle with
# set_output() so they keep streaming live instead of being buffered.
_output = None


def set_output(stream) -> None:
    """Send subsequent events to `stream` (pass None to restore sys.stdout)."""
    global _output
    _output = stream


# One event = one intact line, even when an experiment emits from worker threads
# (e.g. Concordia's engine fans component calls out over a thread pool).
_write_lock = threading.Lock()


def _write(obj: Any) -> None:
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


def emit_raw(type_: str, **fields: Any) -> None:
    """Emit an arbitrary event verbatim — the escape hatch for experiment-specific
    types (or extension fields) the standard shapes don't cover (preserved by
    consumers per the spec)."""
    _write({"type": type_, **fields})


def status(detail: str) -> None:
    _emit("status", Status(detail=detail))


def log(message: str, *, level: str = "info") -> None:
    _emit("log", Log(message=message, level=level))


# Every emitter with more than one field is fully keyword-only: same-typed payload
# args (which string is the channel? name or value first?) make positional calls a
# silent-swap hazard, and consumers shouldn't need per-function rules. Only a lone
# required payload (status/log/emit_raw's first arg) may be positional.
def metric(*, name: str, value: Any, step: int | None = None, unit: str | None = None) -> None:
    _emit("metric", Metric(name=name, value=value, step=step, unit=unit))


def message(*, from_: str, content: str, channel: str, to: str | None = None,
            visible_to: list[str] | None = None, **meta: Any) -> None:
    _emit("message", Message(from_=from_, content=content, channel=channel,
                             to=to, visible_to=visible_to, meta=meta or None))


def llm_call(*, agent: str | None, model: str, request: Any, response: Any = None,
             usage: Any = None, latency_ms: Any = None, error: Any = None,
             **meta: Any) -> None:
    # convert dict args into the typed Structs (validates request.messages etc.)
    ev = msgspec.convert({
        "agent": agent, "model": model, "request": request,
        "response": response, "usage": usage, "latency_ms": latency_ms, "error": error,
        "meta": meta or None,
    }, LlmCall)
    _emit("llm.call", ev)


def agent_event(*, agent: str, kind: str, **data: Any) -> None:
    _emit("agent.event", AgentEvent(agent=agent, kind=kind, data=data))


def artifact(*, name: str, path: str, media_type: str | None = None,
             size: int | None = None) -> None:
    _emit("artifact", Artifact(name=name, path=path, media_type=media_type, bytes=size))
