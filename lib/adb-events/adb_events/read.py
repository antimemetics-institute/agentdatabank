"""Typed readers for event payload JSON and the runner's saved JSONL chunks."""

from collections.abc import Iterator
from pathlib import Path

from pydantic import ValidationError

from .models import EVENT_ADAPTER, Envelope, Payload


def parse_event(payload: str | bytes) -> Payload:
    """Deserialize one payload through the public discriminated union."""
    return EVENT_ADAPTER.validate_json(payload, strict=True)


class EventReadError(ValueError):
    """A record couldn't be decoded; the message identifies its file and line."""


def read_events(source: str | Path) -> Iterator[Envelope]:
    """Read one JSONL file or a run directory, yielding typed envelopes.

    Chunk files are read in numeric order. Unknown types, invalid fields, and
    truncated JSON raise EventReadError rather than silently dropping evidence.
    A valid partial run need not contain run.end. Source files remain untouched.
    """
    source = Path(source)
    if source.is_dir():
        paths = sorted(
            source.glob("events-*.jsonl"),
            key=lambda path: int(path.stem.removeprefix("events-")),
        )
        if not paths:
            raise FileNotFoundError(f"no event chunks in {source}")
    else:
        paths = [source]
    for path in paths:
        with path.open(encoding="utf-8") as stream:
            for number, line in enumerate(stream, 1):
                try:
                    yield Envelope.model_validate_json(line, strict=True)
                except ValidationError as exc:
                    raise EventReadError(f"{path}:{number}: {exc}") from exc
