"""Test helpers for experiment suites.

`assert_conformant(events)` validates captured event dicts against the vocabulary
structs — the same models the emitters construct from, so a passing suite means
the runner's linter will accept the stream. Unknown event types are legal by the
conformance ladder and skipped.
"""

from __future__ import annotations

from collections.abc import Iterable

import msgspec

from .models import EVENT_MODELS


def assert_conformant(events: Iterable[dict]) -> int:
    """Raise if any known-typed event fails to decode as its struct. Returns the
    number of events actually validated (0 means the assertion was vacuous)."""
    checked = 0
    for event in events:
        model = EVENT_MODELS.get(event.get("type"))
        if model is None:
            continue
        body = {key: value for key, value in event.items() if key != "type"}
        try:
            msgspec.json.decode(msgspec.json.encode(body), type=model)
        except msgspec.ValidationError as exc:
            raise AssertionError(f"malformed {event.get('type')!r} event: {exc}\n"
                                 f"{event}") from None
        checked += 1
    return checked
