"""One model-based emission boundary, with socket transport."""

from __future__ import annotations

from .transport import send_event
from .models import PRODUCER_ADAPTER, PRODUCER_MODELS, ProducerPayload


def emit(event: ProducerPayload) -> None:
    """Validate and serialize an event, preserving open metadata verbatim.

    Serialize once, validate the exact wire representation, then write those
    same bytes. Validation may raise but its normalized result is discarded.
    Only public producer models are accepted; experiment-specific observations
    use CustomEvent. The runner alone produces lifecycle events.
    """
    if type(event) not in PRODUCER_MODELS.values():
        raise TypeError(
            "emit expects a public producer model; use CustomEvent for experiment-specific data"
        )
    payload = event.model_dump_json(by_alias=True, warnings="error")
    PRODUCER_ADAPTER.validate_json(payload, strict=True)
    send_event(payload)
