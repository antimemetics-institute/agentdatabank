"""Param validation at the boundary — no inspect_ai import needed."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from adb_inspect.models import Params


def test_defaults_are_keyless_mock():
    p = Params(task="pkg:hello_task:hello")
    assert p.model == "mockllm/model"
    assert p.task_args == {} and p.generate_args == {}
    assert p.limit == 0 and p.epochs == 1 and p.seed == 0


def test_extra_fields_rejected():
    with pytest.raises(ValidationError):
        Params(task="pkg:hello_task:hello", bogus=1)


def test_task_required_nonempty():
    with pytest.raises(ValidationError):
        Params(task="")


def test_negative_limits_rejected():
    with pytest.raises(ValidationError):
        Params(task="x", limit=-1)
    with pytest.raises(ValidationError):
        Params(task="x", epochs=0)
