"""EvalLog -> ADB event stream (docs/plan/events.md).

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
"""

from __future__ import annotations

from typing import Any

from adb_events.emit import agent_event, instance, llm_call, message, metric, status

# Inspect Score.value uses these letter grades; map to 0/1 for numeric metrics.
_GRADE = {"C": 1.0, "I": 0.0, "P": 0.5, "N": 0.0}


def _num(value: Any) -> float | None:
    if isinstance(value, bool):
        return float(value)
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        return _GRADE.get(value.strip().upper())
    return None


def _model_events(sample: Any) -> list:
    return [e for e in (sample.events or []) if type(e).__name__ == "ModelEvent"]


def _dump(obj: Any) -> Any:
    """Best-effort JSON-able form for a pydantic model (ChatMessage, GenerateConfig)."""
    if obj is None:
        return None
    md = getattr(obj, "model_dump", None)
    return md(mode="json") if callable(md) else obj


def emit_provenance(log: Any, agent: str) -> None:
    """Record the exact identity of everything wrapped, as a first-class covariate
    (specs/comparability.md): the upstream package versions (inspect_ai +
    inspect_evals), the task version, and the dataset/source identity. Comparability
    is judged retroactively as slices over these, so a fact not recorded here can
    never be sliced on — this is the one thing that cannot be backfilled."""
    e = getattr(log, "eval", None)
    if e is None:
        return
    ds = getattr(e, "dataset", None)
    rev = getattr(e, "revision", None)
    agent_event(
        agent=agent, kind="provenance",
        packages=e.packages or {},
        task=e.task,
        task_version=e.task_version,
        task_registry_name=getattr(e, "task_registry_name", None),
        # model id is recorded; the base URL is NOT — where a model is served is the
        # runner's environment (and often a private home address), not provenance
        model=e.model,
        dataset=({"name": ds.name, "location": ds.location, "samples": ds.samples}
                 if ds is not None else None),
        # git identity of the task source (dataset pinning is roadmap; recorded
        # meanwhile so drift is at least visible, not silent)
        revision=({"origin": rev.origin, "commit": rev.commit, "dirty": rev.dirty}
                  if rev is not None else None),
    )


def emit_model_event(ev: Any, agent: str, sample_id: Any, epoch: Any) -> None:
    """One ModelEvent -> one `llm.call`, tagged with the sample it served (one eval
    works through many problems, sequentially or in parallel, so untagged calls are
    unattributable)."""
    out = ev.output
    usage = None
    if out is not None and out.usage is not None:
        usage = {"input_tokens": out.usage.input_tokens,
                 "output_tokens": out.usage.output_tokens}
    # Build the ADB-shaped request/response from the ModelEvent's STRUCTURED
    # fields — ev.input is the message list as sent, ev.output.message the reply.
    # The raw provider payload (ev.call) follows the vendor wire schema (OpenAI
    # Responses API for reasoning models: `include`, `max_output_tokens`, …), not
    # events.md, so it goes under response.raw for provenance, never as the top
    # level (that's what tripped the runner's `request.messages required` lint).
    request = {
        "messages": [_dump(m) for m in (ev.input or [])],
        "params": _dump(ev.config) or {},
    }
    response: Any
    if out is not None:
        response = {
            "message": _dump(out.message) if out.message is not None else None,
            "finish_reason": out.stop_reason,
            # the provider-echoed RESOLVED model id (ModelOutput.model), distinct
            # from the requested id in ev.model: if a run names a moving alias
            # (claude-sonnet-4-5, gpt-4o), this records what it resolved to at
            # the moment of use — recorded before anyone knows it matters
            # (specs/comparability.md), so alias drift is sliceable forever
            "model": getattr(out, "model", None),
        }
        if ev.call is not None and ev.call.response is not None:
            response["raw"] = ev.call.response
    else:
        response = None
    latency = round(ev.working_time * 1000) if ev.working_time else None
    err = {"kind": "model_error", "message": str(ev.error)} if ev.error else None
    llm_call(agent=agent, model=ev.model, request=request, response=response,
             usage=usage, latency_ms=latency, error=err,
             instance_id=sample_id, repeat=epoch)


def emit_live_model_event(ev: Any, agent: str, sample_id: Any, epoch: Any,
                          seen_messages: set) -> None:
    """Live-stream one completed ModelEvent: first any chat turns not yet emitted
    (its input plus the reply, deduped by message id into `seen_messages`), then the
    `llm.call` — so the transcript grows as the sample runs, not at its end."""
    channel = f"instance:{sample_id}"
    turns = list(ev.input or [])
    if ev.output is not None and ev.output.message is not None:
        turns.append(ev.output.message)
    for m in turns:
        mid = getattr(m, "id", None)
        if mid is None or mid in seen_messages:
            continue
        seen_messages.add(mid)
        message(from_=m.role, content=m.text or "", channel=channel, role=m.role,
                instance_id=sample_id, repeat=epoch)
    emit_model_event(ev, agent, sample_id, epoch)


_SCALAR = (int, float, str, bool)


def _flat_scores(scores: dict) -> dict:
    """Inspect Score.value per scorer → the spec's flat scalar map: dict-valued
    scorers (agentharm's combined_scorer) flatten with '/'-joined names; a
    non-scalar leaf stringifies (degraded-but-correct — the raw .eval artifact
    keeps the original)."""
    out: dict = {}
    for scorer, v in scores.items():
        if isinstance(v, dict):
            for k, leaf in v.items():
                out[f"{scorer}/{k}"] = leaf if isinstance(leaf, _SCALAR) else str(leaf)
        else:
            out[scorer] = v if isinstance(v, _SCALAR) else str(v)
    return out


def emit_sample(sample: Any, agent: str, *,
                seen_messages: set | None = None,
                seen_events: set | None = None) -> None:
    """Emit a completed sample as one spec instance. `seen_*` are ids already
    streamed live by the caller's hooks (emit_live_model_event) — skipped here, so
    this doubles as the reconciliation pass: anything the live path missed comes
    out now."""
    channel = f"instance:{sample.id}"
    meta_base = {"instance_id": sample.id, "repeat": sample.epoch}

    for msg in sample.messages or []:
        if seen_messages and getattr(msg, "id", None) in seen_messages:
            continue
        message(from_=msg.role, content=msg.text or "", channel=channel,
                role=msg.role, **meta_base)

    for ev in _model_events(sample):
        if seen_events and getattr(ev, "uuid", None) in seen_events:
            continue
        emit_model_event(ev, agent, sample.id, sample.epoch)

    instance(agent=agent, id=sample.id, repeat=sample.epoch,
             target=sample.target,
             scores=_flat_scores({k: v.value for k, v in (sample.scores or {}).items()}),
             error=str(sample.error) if sample.error else None)


def headline(log: Any) -> tuple[float, str]:
    """Pick the run's single reportable score: an `accuracy`-named aggregate metric
    if present, else the first numeric aggregate metric. Returns (value, name)."""
    results = getattr(log, "results", None)
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


def emit_aggregate(log: Any, agent: str) -> dict:
    """The run-level tail: aggregate scorer metrics, token totals, and the scalar
    results summary. Emitted once after the eval — the per-sample events (message /
    llm.call / agent.event) stream separately as each sample completes."""
    results = getattr(log, "results", None)
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

    summary = {"status": log.status, "samples": total, "completed": completed,
               "errors": errors, "score": score, "score_name": score_name,
               "tokens_input": ti, "tokens_output": to}
    for k, v in summary.items():
        metric(name=k, value=v)
    return summary


def emit_all(log: Any, agent: str) -> dict:
    """Translate the whole EvalLog at once (the batch path — used by tests and any
    caller that has a finished log). main.py streams instead: samples via a hook,
    then emit_aggregate."""
    status(f"eval {log.status}: {getattr(log.eval, 'task', '?')} on {agent}")
    emit_provenance(log, agent)
    for sample in log.samples or []:
        emit_sample(sample, agent)
    return emit_aggregate(log, agent)
