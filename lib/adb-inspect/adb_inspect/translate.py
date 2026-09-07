"""EvalLog -> ADB event stream (docs/book/src/reference/events.md).

Inspect's sample/epoch vocabulary maps onto the spec's instance convention at the
wire boundary: each dataset sample is an *instance* (channel `instance:<id>`,
`meta.instance_id` on its messages/llm.calls), each epoch a *repeat*, and each
sample closes with an `instance` event carrying its scores as a FLAT scalar map
(dict-valued scorers flatten with '/'-joined names). `metric` events are
run-level only — aggregate scorer metrics and token totals, emitted last.
(Per-instance scores are NOT metrics: a metric has no instance scope, so N
same-named events are unreadable — that's what buried the agentharm UI.)

Inspect telemetry is secondary data (transcript-derived), so callers may weigh
it accordingly — same posture as the harness normalizers in specs/harness.md.

Annotations use the real pinned inspect types (TYPE_CHECKING only — importing
inspect_ai at module scope would defeat main.py's lazy heavy-import posture);
guards below mirror what those types actually promise: `output` and `eval` are
required fields, so the empty-response case is `not output.choices`, never None.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any

from adb_events.emit import agent_event, instance, llm_call, message, metric, status

if TYPE_CHECKING:
    from inspect_ai.event import ModelEvent
    from inspect_ai.log import EvalLog, EvalSample
    from inspect_ai.model import ChatMessage
    from inspect_ai.scorer import Value
    from pydantic import BaseModel

# Inspect Score.value uses these letter grades; map to 0/1 for numeric metrics.
_GRADE = {"C": 1.0, "I": 0.0, "P": 0.5, "N": 0.0}


def _num(value: Value) -> float | None:
    if isinstance(value, bool):
        return float(value)
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        return _GRADE.get(value.strip().upper())
    return None


def _model_events(sample: EvalSample) -> list[ModelEvent]:
    # runtime import: by the time a sample exists the eval ran, so inspect_ai is
    # long since loaded — this is a dict lookup, not an import cost
    from inspect_ai.event import ModelEvent
    return [e for e in (sample.events or []) if isinstance(e, ModelEvent)]


def _dump(obj: BaseModel | None) -> dict[str, Any] | None:
    """JSON-able form of a pydantic model (ChatMessage, GenerateConfig), nulls
    omitted — a GenerateConfig is ~40 fields of None around the two that were set,
    and the wire wants the two."""
    return None if obj is None else obj.model_dump(mode="json", exclude_none=True)


def emit_provenance(log: EvalLog, agent: str) -> None:
    """Record available package/task versions and dataset/source metadata.

    Dataset name, location, and sample count are not a content fingerprint.
    """
    e = log.eval
    ds = e.dataset
    rev = e.revision
    agent_event(
        agent=agent, kind="provenance",
        packages=e.packages or {},
        task=e.task,
        task_version=e.task_version,
        task_registry_name=e.task_registry_name,
        # model id is recorded; the base URL is NOT — where a model is served is the
        # runner's environment (and often a private home address), not provenance
        model=e.model,
        dataset={"name": ds.name, "location": ds.location, "samples": ds.samples},
        # git identity of the task source (dataset pinning is roadmap; recorded
        # meanwhile so drift is at least visible, not silent)
        revision=({"origin": rev.origin, "commit": rev.commit, "dirty": rev.dirty}
                  if rev is not None else None),
    )


def emit_model_event(ev: ModelEvent, agent: str,
                     sample_id: str | int, epoch: int) -> None:
    """One ModelEvent -> one `llm.call`, tagged with the sample it served (one eval
    works through many problems, sequentially or in parallel, so untagged calls are
    unattributable)."""
    out = ev.output
    usage = None
    if out.usage is not None:
        usage = {"input_tokens": out.usage.input_tokens,
                 "output_tokens": out.usage.output_tokens}
    # Build the ADB-shaped request/response from the ModelEvent's STRUCTURED
    # fields — ev.input is the message list as sent, ev.output.message the reply.
    # The raw provider payload (ev.call) follows the vendor wire schema (OpenAI
    # Responses API for reasoning models: `include`, `max_output_tokens`, …), not
    # events.md, so it goes under response.raw for provenance, never as the top
    # level (that's what tripped the runner's `request.messages required` lint).
    request: dict[str, Any] = {
        "messages": [_dump(m) for m in ev.input],
        "params": _dump(ev.config) or {},
    }
    # `output` is a required field; "no reply" is an output with no choices (and
    # .message/.stop_reason raise on that), so choices is the gate
    response: dict[str, Any] | None = None
    if out.choices:
        response = {
            "message": _dump(out.message),
            "finish_reason": out.stop_reason,
            # Provider-reported model, distinct from the requested ID in ev.model.
            # A reported name alone does not establish model equivalence.
            "model": out.model,
        }
        if ev.call is not None and ev.call.response is not None:
            response["raw"] = ev.call.response
    latency = round(ev.working_time * 1000) if ev.working_time else None
    err = {"kind": "model_error", "message": str(ev.error)} if ev.error else None
    llm_call(agent=agent, model=ev.model, request=request, response=response,
             usage=usage, latency_ms=latency, error=err,
             instance_id=sample_id, repeat=epoch)


def emit_live_model_event(ev: ModelEvent, agent: str, sample_id: str | int,
                          epoch: int, seen_messages: set[str]) -> None:
    """Live-stream one completed ModelEvent: first any chat turns not yet emitted
    (its input plus the reply, deduped by message id into `seen_messages`), then the
    `llm.call` — so the transcript grows as the sample runs, not at its end."""
    channel = f"instance:{sample_id}"
    turns: list[ChatMessage] = list(ev.input)
    if ev.output.choices:
        turns.append(ev.output.message)
    for m in turns:
        if m.id is None or m.id in seen_messages:
            continue
        seen_messages.add(m.id)
        message(from_=m.role, content=m.text or "", channel=channel, role=m.role,
                instance_id=sample_id, repeat=epoch)
    emit_model_event(ev, agent, sample_id, epoch)


_SCALAR = (int, float, str, bool)


def _flat_scores(scores: Mapping[str, Value]) -> dict[str, int | float | str | bool]:
    """Inspect Score.value per scorer → the spec's flat scalar map: dict-valued
    scorers (agentharm's combined_scorer) flatten with '/'-joined names; a
    non-scalar leaf stringifies (degraded-but-correct — the raw .eval artifact
    keeps the original)."""
    out: dict[str, int | float | str | bool] = {}
    for scorer, v in scores.items():
        if isinstance(v, Mapping):
            for k, leaf in v.items():
                out[f"{scorer}/{k}"] = leaf if isinstance(leaf, _SCALAR) else str(leaf)
        else:
            out[scorer] = v if isinstance(v, _SCALAR) else str(v)
    return out


def emit_sample(sample: EvalSample, agent: str, *,
                seen_messages: set[str] | None = None,
                seen_events: set[str] | None = None) -> None:
    """Emit a completed sample as one spec instance. `seen_*` are ids already
    streamed live by the caller's hooks (emit_live_model_event) — skipped here, so
    this doubles as the reconciliation pass: anything the live path missed comes
    out now."""
    channel = f"instance:{sample.id}"

    for msg in sample.messages:
        if seen_messages and msg.id in seen_messages:
            continue
        message(from_=msg.role, content=msg.text or "", channel=channel,
                role=msg.role, instance_id=sample.id, repeat=sample.epoch)

    for ev in _model_events(sample):
        if seen_events and ev.uuid in seen_events:
            continue
        emit_model_event(ev, agent, sample.id, sample.epoch)

    instance(agent=agent, id=sample.id, repeat=sample.epoch,
             target=sample.target,
             scores=_flat_scores({k: v.value for k, v in (sample.scores or {}).items()}),
             # .message, not str(): EvalError's str() is its pydantic dump
             error=sample.error.message if sample.error else None)


def headline(log: EvalLog) -> tuple[float, str]:
    """Pick the run's single reportable score: an `accuracy`-named aggregate metric
    if present, else the first numeric aggregate metric. Returns (value, name)."""
    results = log.results
    if not results:
        return 0.0, ""
    first: tuple[float, str] | None = None
    for score in results.scores:
        for name, m in score.metrics.items():
            num = _num(m.value)
            if num is None:
                continue
            qualified = f"{score.name}/{name}"
            if name == "accuracy":
                return num, qualified
            if first is None:
                first = (num, qualified)
    return first if first is not None else (0.0, "")


def emit_aggregate(log: EvalLog, agent: str) -> dict[str, Any]:
    """The run-level tail: aggregate scorer metrics, token totals, and the scalar
    results summary. Emitted once after the eval — the per-sample events (message /
    llm.call / agent.event) stream separately as each sample completes."""
    results = log.results
    if results:
        for score in results.scores:
            for name, m in score.metrics.items():
                num = _num(m.value)
                if num is not None:
                    metric(name=f"{score.name}/{name}", value=num)

    ti = to = 0
    for usage in (log.stats.model_usage or {}).values():
        ti += usage.input_tokens or 0
        to += usage.output_tokens or 0
    metric(name="tokens_input", value=ti)
    metric(name="tokens_output", value=to)

    total = results.total_samples if results else 0
    completed = results.completed_samples if results else 0
    errors = sum(1 for s in (log.samples or []) if s.error)
    score, score_name = headline(log)

    summary: dict[str, Any] = {
        "samples": total, "completed": completed,
        "errors": errors, "score": score, "score_name": score_name,
        "tokens_input": ti, "tokens_output": to,
    }
    for k, v in summary.items():
        metric(name=k, value=v)
    return summary


def emit_all(log: EvalLog, agent: str) -> dict[str, Any]:
    """Translate the whole EvalLog at once (the batch path — used by tests and any
    caller that has a finished log). main.py streams instead: samples via a hook,
    then emit_aggregate."""
    status(f"eval {log.status}: {log.eval.task} on {agent}")
    emit_provenance(log, agent)
    for sample in log.samples or []:
        emit_sample(sample, agent)
    return emit_aggregate(log, agent)
