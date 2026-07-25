"""Params validation at the config boundary — no Concordia import needed."""

import pytest
from pydantic import ValidationError

from concordia_sim.models import AgentSpec, Params


def test_defaults_are_keyless_mock():
    p = Params()
    assert p.default_model == "mock/model"
    assert p.max_steps == 6
    assert p.seed == 0
    # the scenario is the roster: a sensible two-agent default
    assert [a.name for a in p.agents] == ["Alice", "Bob"]


def test_agents_are_the_scenario():
    p = Params(agents=[{"name": "Mira", "goal": "sell high"},
                       {"name": "Tom", "goal": "buy low"}],
               premise="a market")
    assert [a.name for a in p.agents] == ["Mira", "Tom"]
    assert p.agents[0].goal == "sell high"


def test_extra_keys_forbidden():
    with pytest.raises(ValidationError):
        Params(scenariooo="typo")


def test_agent_extra_keys_forbidden():
    with pytest.raises(ValidationError):
        AgentSpec(name="X", role="villain")


def test_too_few_agents_rejected():
    with pytest.raises(ValidationError):
        Params(agents=[{"name": "Solo"}])


def test_nameless_agent_rejected():
    with pytest.raises(ValidationError):
        AgentSpec(name="")


def test_nonpositive_steps_rejected():
    with pytest.raises(ValidationError):
        Params(max_steps=0)


def test_bad_temperature_rejected():
    with pytest.raises(ValidationError):
        Params(temperature=5.0)
