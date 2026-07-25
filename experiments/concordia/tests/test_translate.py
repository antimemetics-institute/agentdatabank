"""translate.py over hand-built data — pure, no Concordia import."""

import json

from concordia_sim.translate import emit_provenance, emit_scene, emit_summary, emit_turn


def _events(capsys):
    out = capsys.readouterr().out
    return [json.loads(line) for line in out.splitlines() if line.strip()]


def test_scene_then_turns_stream_one_at_a_time(capsys):
    roster = {"Alice", "Bob"}
    assert emit_scene("Alice and Bob meet at a cafe.") == 1
    # the "-- " speech marker and wrapping quotes are cleaned into a plain spoken line
    assert emit_turn(1, "Alice", 'Alice -- "Hi Bob!"', roster) == 1
    assert emit_turn(2, "Bob", "Bob Good to see you.", roster) == 1

    events = _events(capsys)
    assert [e["type"] for e in events] == ["message"] * 3
    assert all(e["channel"] == "world" for e in events)
    assert [e["from"] for e in events] == ["Game Master", "Alice", "Bob"]
    assert events[0]["content"] == "Alice and Bob meet at a cafe."
    assert events[1]["content"] == "Hi Bob!"
    assert events[2]["content"] == "Good to see you."


def test_non_roster_and_empty_turns_dropped(capsys):
    roster = {"Alice", "Bob"}
    assert emit_scene("") == 0  # no premise -> no scene message
    assert emit_turn(1, "(setup)", "...", roster) == 0  # setup phase, not a roster member
    assert emit_turn(2, "Alice", "Alice:   ", roster) == 0  # empty action
    assert emit_turn(3, "Bob", "Bob: hello", roster) == 1
    events = _events(capsys)
    assert [e["from"] for e in events] == ["Bob"]


def test_semantic_events_from_raw_log(capsys):
    from concordia_sim.translate import TurnEmitter

    turns = TurnEmitter({"Alice", "Bob"})
    turns.raw_log.append({
        "Step": 1,
        "Summary": "noise",
        "Entity [Alice]": {
            "__observation__": {"Value": ["[observation] Bob waves."]},
            "SelfPerception": {"State": "Alice is warm.",
                               "Chain of thought": ["never emitted"]},
            "SituationPerception": {"State": "Alice is in a cafe."},
            "ConversationDynamics": {"State": "opening pleasantries"},
        },
        "Game Master --- Event: x": {"terminate": {"__act__": {"Value": "No"}}},
    })
    turns.drain()
    # rolling window: step 3 re-lists the old observation plus one new one
    turns.raw_log.append({
        "Step": 3,
        "Entity [Alice]": {
            "__observation__": {"Value": ["[observation] Bob waves.",
                                          "[observation] Event: Alice -- \"hi\"",
                                          "[observation] Bob sits down."]},
            "SelfPerception": {"State": "Alice is curious."},
        },
    })
    turns.drain()
    events = _events(capsys)

    obs = [e for e in events if e["type"] == "message" and e["channel"] == "observation"]
    assert [(e["to"], e["content"]) for e in obs] == [
        ("Alice", "Bob waves."), ("Alice", "Bob sits down.")]  # each exactly once

    percs = [e for e in events if e["type"] == "agent.event" and e["kind"] == "perception"]
    assert [p["data"]["self"] for p in percs] == ["Alice is warm.", "Alice is curious."]
    assert percs[0]["data"]["situation"] == "Alice is in a cafe."
    # GM bookkeeping never becomes a semantic event
    assert not any(e.get("agent") == "Game Master" for e in percs)


def test_provenance_is_an_agent_event(capsys):
    emit_provenance(concordia_version="2.4.0", model="mock/model",
                    agents=2, python_version="3.13.0")
    (event,) = _events(capsys)
    assert event["type"] == "agent.event"
    assert event["kind"] == "provenance"
    assert event["data"]["concordia"] == "2.4.0"
    assert event["data"]["agents"] == 2


def test_summary_emits_metrics_and_returns_dict(capsys):
    summary = emit_summary(status_str="completed", steps=3, agents=2,
                           world_events=9, model_calls=14)
    assert summary == {"status": "completed", "steps": 3, "agents": 2,
                       "world_events": 9, "model_calls": 14}
    events = _events(capsys)
    assert {e["type"] for e in events} == {"metric"}
    assert {e["name"]: e["value"] for e in events} == summary
