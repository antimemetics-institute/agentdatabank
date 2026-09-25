"""Typed access to the canonical provider registry (providers.toml, packaged here).

The registry is DATA — see the TOML's own header for the vocabulary, the two var
roles, and the layer rules. This module parses it into frozen kw-only dataclasses
and validates the naming conventions; the roles themselves are structural, so there
is nothing to infer. Zero dependencies, by design: the runner and the chat helper
both consume this without dragging anything else in, and repo-side scripts that
shouldn't take a dependency at all read the TOML directly.

Model-name parsing and the served-model alias rule also live here so clients and
saved-run audits use the same interpretation of routing prefixes.
"""

from __future__ import annotations

import tomllib
import re
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True, kw_only=True)
class ApiKey:
    """The template's secret: hidden at the setup prompt, masked in listings.
    `required` = a value must exist at runtime — consumers fail early and
    actionably when it doesn't."""

    name: str
    required: bool = True


@dataclass(frozen=True, kw_only=True)
class BaseUrl:
    """The template's endpoint, always the plain API origin. `default` is offered
    at the setup prompt (Enter adopts it) and used as the runtime fallback; empty
    means setup and runtime both require an explicit value."""

    name: str
    default: str = ""


@dataclass(frozen=True, kw_only=True)
class Provider:
    """A canonical provider: the model-id prefix and its credential template."""

    name: str
    api_key: ApiKey
    base_url: BaseUrl


def _parse(text: str) -> tuple[dict[str, Provider], set[str]]:
    data = tomllib.loads(text)
    providers = {
        name: Provider(
            name=name,
            api_key=ApiKey(**p["api_key"]),
            base_url=BaseUrl(**p["base_url"]),
        )
        for name, p in data["providers"].items()
    }
    return providers, set(data["mock_prefixes"])


def _validate(providers: dict[str, Provider], mock_prefixes: set[str]) -> None:
    # Naming conventions — the roles themselves are structural. Import-time so a
    # bad entry can never ship.
    for name, p in providers.items():
        assert name == p.name and name == name.lower() and "/" not in name, name
        for var in (p.api_key.name, p.base_url.name):
            assert var == var.upper(), f"{name}: {var} not UPPER_SNAKE"
        assert p.api_key.name != p.base_url.name, name
    assert providers.keys().isdisjoint(mock_prefixes)


PROVIDERS, MOCK_PREFIXES = _parse(
    (Path(__file__).parent / "providers.toml").read_text()
)
_validate(PROVIDERS, MOCK_PREFIXES)


def requested_model_name(model_id: str) -> str:
    """Remove routing prefixes, preserving slashes within the model name.

    Inspect's openai-api/SERVICE/MODEL form has two routing components.
    Bare names are already model names.
    """
    if model_id.startswith("openai-api/"):
        return model_id.split("/", 2)[-1]
    return model_id.partition("/")[2] if "/" in model_id else model_id


def served_model_matches(requested: str, served: str) -> bool:
    """Allow case differences and a snapshot suffix when resolving an alias."""
    name = requested_model_name(requested)
    return bool(name) and served.casefold().startswith(name.casefold())


def model_family(served_model: str) -> str | None:
    """Recognize a model family by served name, independently of routing prefixes.
    Only families with wire-level quirks are named; everything else is None."""
    name = served_model.casefold()
    if re.match(r"(mistral|ministral|codestral|devstral|magistral|pixtral|voxtral)", name):
        return "mistral"
    return None
