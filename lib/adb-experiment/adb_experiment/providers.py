"""Provider prefixes -> OpenAI-compatible endpoints, resolved from the environment.

A model id's provider prefix (``anthropic/claude-…``, ``groq/llama-…``) picks which
credential set to read and which endpoint to talk to; every provider here serves the
OpenAI **/chat/completions** wire protocol, either natively or through a compatibility
mount. Each mapping is declared in ``PROVIDERS`` — explicit per provider, never
inferred from the id's shape. The runner injects the env vars from its credential
store (``adb-runner providers``); this module only reads them.

Stdlib only. A provider belongs here only if its endpoint takes a plain bearer key
over the OpenAI protocol — OAuth-only surfaces (Vertex) have no entry;
degraded-but-correct beats a mapping that half-works. (The runner keeps its own
prompt-template registry for `providers set`; unifying the two tables is part of
the credentials-design migration.)
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass


@dataclass(frozen=True)
class Endpoint:
    """A resolved backend: where to POST and how to authenticate."""

    provider: str
    served_model: str  # the id with the provider prefix stripped — sent as `model`
    base_url: str      # OpenAI-compat mount (an OpenAI-SDK `base_url`)
    api_key: str


@dataclass(frozen=True)
class _Spec:
    key_env: str
    base_env: str
    default_base: str | None  # None = the base-url env var is required
    mount_suffix: str = ""    # appended to the base: where the compat layer is mounted
    keyless_ok: bool = False  # local servers (llama.cpp, ollama) often need no key


# The base-url env var overrides the default origin/mount for a provider (proxies,
# regional endpoints); `mount_suffix` is appended to either, so e.g. the stored
# ANTHROPIC_BASE_URL stays the plain API origin the rest of the ecosystem expects.
PROVIDERS: dict[str, _Spec] = {
    "openai": _Spec("OPENAI_API_KEY", "OPENAI_BASE_URL", None, keyless_ok=True),
    "anthropic": _Spec("ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL",
                       "https://api.anthropic.com", mount_suffix="/v1"),
    "google": _Spec("GOOGLE_API_KEY", "GOOGLE_BASE_URL",
                    "https://generativelanguage.googleapis.com/v1beta/openai"),
    "groq": _Spec("GROQ_API_KEY", "GROQ_BASE_URL", "https://api.groq.com/openai/v1"),
    "mistral": _Spec("MISTRAL_API_KEY", "MISTRAL_BASE_URL", "https://api.mistral.ai/v1"),
    "grok": _Spec("GROK_API_KEY", "GROK_BASE_URL", "https://api.x.ai/v1"),
    "moonshotai": _Spec("MOONSHOTAI_API_KEY", "MOONSHOTAI_BASE_URL",
                        "https://api.moonshot.ai/v1"),
    "openrouter": _Spec("OPENROUTER_API_KEY", "OPENROUTER_BASE_URL",
                        "https://openrouter.ai/api/v1"),
    # No universal origin for these two — the base-url env var is required and holds
    # the full mount verbatim. azureai: the v1 surface, `https://<resource>
    # .openai.azure.com/openai/v1`, model = your deployment name. bedrock: e.g.
    # `https://bedrock-runtime.<region>.amazonaws.com/v1` with a Bedrock API key,
    # model = the Bedrock model id (`us.anthropic.claude-...`).
    "azureai": _Spec("AZUREAI_API_KEY", "AZUREAI_BASE_URL", None),
    "bedrock": _Spec("AWS_BEARER_TOKEN_BEDROCK", "BEDROCK_BASE_URL", None),
}


def _supported() -> str:
    return ", ".join(f"`{p}/`" for p in PROVIDERS)


def resolve(model_id: str, env: Mapping[str, str] = os.environ) -> Endpoint:
    """Resolve a real (non-mock) model id to an Endpoint, or raise ValueError with an
    actionable message. Every error names the env var or credential set to fix."""
    provider, sep, served = model_id.partition("/")
    spec = PROVIDERS.get(provider) if sep else None
    if spec is None:
        raise ValueError(
            f"model {model_id!r}: this experiment's client only speaks the OpenAI "
            f"chat protocol — supported prefixes: {_supported()} (each provider's "
            "OpenAI-compatible endpoint; `openai/<served-name>` reaches any such "
            "server: llama.cpp, vLLM, ollama, or api.openai.com itself), or a "
            "`mock/...` id to run keyless"
        )
    base = (env.get(spec.base_env) or spec.default_base or "").rstrip("/")
    if not base:
        raise ValueError(
            f"model {model_id!r} needs an OpenAI-compatible endpoint but "
            f"${spec.base_env} is unset — configure the provider with "
            f"`nix run .#adb-runner -- providers set {provider}`, or use a mock/ "
            "model to run keyless"
        )
    if not base.startswith(("http://", "https://")):
        raise ValueError(
            f"${spec.base_env} is {base!r} but must be a full http(s) URL including "
            "scheme, host, port, and any path prefix the server mounts the OpenAI "
            "API under — e.g. http://llama.local:11434/v1 for a local llama.cpp "
            "(the client appends /chat/completions itself)"
        )
    api_key = env.get(spec.key_env) or ""
    if not api_key:
        if not spec.keyless_ok:
            raise ValueError(
                f"model {model_id!r} needs ${spec.key_env} — configure the provider "
                f"with `nix run .#adb-runner -- providers set {provider}`, or use a "
                "mock/ model to run keyless"
            )
        api_key = "dummy"  # a bearer token local servers will ignore
    return Endpoint(
        provider=provider,
        served_model=served,
        base_url=base + spec.mount_suffix,
        api_key=api_key,
    )
