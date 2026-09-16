"""Typed readers for event payload JSON and the runner's saved JSONL stream."""

from collections.abc import Iterator
import json
from pathlib import Path
from typing import Any, overload

from pydantic import TypeAdapter

from .models import EVENT_ADAPTER, Envelope, Payload


def parse_event(payload: str | bytes) -> Payload:
    """Deserialize one payload through the public discriminated union."""
    return EVENT_ADAPTER.validate_json(payload, strict=True)


class EventReadError(ValueError):
    """A record couldn't be decoded; the message identifies its file and line."""


@overload
def read_events(source: str | Path, *, payload: None = None) -> Iterator[Envelope]: ...


@overload
def read_events[T](source: str | Path, *, payload: type[T] | TypeAdapter[T]) -> Iterator[Envelope[T]]: ...


@overload
def read_events(source: str | Path, *, payload: Any) -> Iterator[Envelope[Any]]: ...


def read_events(source: str | Path, *, payload: Any = None) -> Iterator[Envelope[Any]]:
    """Read one JSONL file or a run directory, yielding typed envelopes.

    A run directory contains exactly events.jsonl. Unknown types, invalid fields, and
    truncated JSON raise EventReadError rather than silently dropping evidence.
    A valid partial run need not contain run.end. Source files remain untouched.
    Pass an experiment's payload union or TypeAdapter to decode its custom events.
    An explicitly typed TypeAdapter also preserves its union in static type checking.
    """
    supplied: TypeAdapter[Any] = payload
    adapter = (supplied if isinstance(payload, TypeAdapter) else TypeAdapter[Any](payload)
               if payload is not None else None)
    source = Path(source)
    path = source / "events.jsonl" if source.is_dir() else source
    if path.name != "events.jsonl":
        raise ValueError("run streams must be named events.jsonl")
    paths = [path]
    for path in paths:
        with path.open(encoding="utf-8") as stream:
            for number, line in enumerate(stream, 1):
                try:
                    if adapter is None:
                        record = Envelope.model_validate_json(line, strict=True)
                    else:
                        # Validate the envelope independently, then validate the
                        # event in JSON mode with the experiment's complete union.
                        record = Envelope[Any].model_validate_json(line, strict=True)
                        record.event = adapter.validate_json(json.dumps(record.event), strict=True)
                    yield record
                except ValueError as exc:
                    raise EventReadError(f"{path}:{number}: {exc}") from exc
