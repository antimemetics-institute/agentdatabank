"""An OpenAI-SDK-shaped chat client with ADB instrumentation built in.

For experiments that call models directly (their own loop, or a wrapped framework
that accepts an OpenAI client): construct `ChatClient(model_id, ...)` and hand it
wherever a `openai.OpenAI()` instance would go — it duck-types the one surface
frameworks actually use, ``.chat.completions.create``. In exchange:

  * the model id's provider prefix picks the endpoint and credential set
    (:mod:`adb_events.providers` — openai, anthropic, google, groq, mistral, grok,
    openrouter, azureai, bedrock; each an OpenAI-compatible mount), and ``mock/...``
    runs keyless and offline with a deterministic responder — the smoke/CI path,
    uniform across experiments (the runner's mock convention);
  * every call emits one ``llm.call`` event — the verbatim reply, token usage, and
    latency — attributed to the constructing `agent`;
  * run-level generation params apply uniformly: `temperature` overrides (it is the
    run's declared axis), `seed` fills in when the caller passes none, `max_tokens`
    caps whatever the caller asks for;
  * local reasoning models are accommodated: qwen served names get llama.cpp/vLLM's
    ``chat_template_kwargs.enable_thinking=false``, and ``<think>`` blocks are
    stripped from the content handed back (the event keeps the reply verbatim).

Needs the ``openai`` SDK — depend on ``adb-events[llm]``. Import stays inside this
module so the base package adds no requirement.
"""

from __future__ import annotations

import hashlib
import re
import threading
import time
import types
from collections.abc import Callable
from typing import Any

from adb_events.emit import llm_call

from .providers import resolve

_THINK = re.compile(r"<think>.*?</think>", re.DOTALL)
_THINK_OPEN = re.compile(r"<think>.*$", re.DOTALL)  # unclosed (truncated) reasoning


def strip_think(text: str) -> str:
    """Strip a reasoning model's <think> blocks — complete pairs, an unclosed block
    left by a token cutoff, and any stray closing tag."""
    text = _THINK.sub("", text)
    text = _THINK_OPEN.sub("", text)
    return text.replace("</think>", "").strip()


# neutral deterministic lines for the default mock responder — enough variety that
# loops which detect repetition still make progress
_MOCK_LINES = (
    "That seems reasonable. Let's continue.",
    "Understood. Here is my considered response.",
    "Interesting — I had not thought of it that way.",
    "I agree with the direction so far.",
    "Let me suggest we take the next step.",
    "Fair enough. What would you like to do next?",
)


def deterministic_pick(seed: int, text: str, n: int) -> int:
    """A pure (seed, text) -> [0, n) index — the mock backend's only randomness."""
    digest = hashlib.sha256(f"{seed}|{text}".encode()).digest()
    return int.from_bytes(digest[:8], "big") % n


class ChatClient:
    """See module docstring. `mock_responder` (messages -> str) customizes the mock
    backend's reply; the default picks deterministically from a neutral line bank."""

    def __init__(
        self,
        model_id: str,
        *,
        agent: str | None = None,
        temperature: float | None = None,
        seed: int | None = None,
        max_tokens: int | None = None,
        mock_responder: Callable[[list[dict]], str] | None = None,
    ) -> None:
        self.model_id = model_id
        self.agent = agent
        self.n_calls = 0
        self._count_lock = threading.Lock()
        self._temperature = temperature
        self._seed = seed
        self._max_tokens = max_tokens
        self.is_mock = model_id.startswith("mock/")
        self._mock_responder = mock_responder or self._default_mock_responder
        if self.is_mock:
            self.served_model = model_id.split("/", 1)[1]
            self.base_url = ""
            self._sdk = None
            self._disable_thinking = False
        else:
            import openai  # the [llm] extra; only this module needs it

            endpoint = resolve(model_id)  # ValueError with the fix in the message
            self.served_model = endpoint.served_model
            self.base_url = endpoint.base_url
            # Qwen is a reasoning model: left alone it spends the whole token budget
            # inside <think>…</think> and returns an empty answer. The reliable switch
            # is the chat endpoint's chat_template_kwargs (llama.cpp/vLLM); strip_think
            # still covers any that slip through.
            self._disable_thinking = "qwen" in self.served_model.lower()
            self._sdk = openai.OpenAI(api_key=endpoint.api_key,
                                      base_url=endpoint.base_url)
        # the one surface frameworks use; duck-typed so no SDK subclassing is needed
        self.chat = types.SimpleNamespace(
            completions=types.SimpleNamespace(create=self._create)
        )

    # -- the instrumented create ---------------------------------------------

    def _create(self, **kw: Any) -> Any:
        # the run's declared generation params, applied uniformly
        if self._temperature is not None:
            kw["temperature"] = self._temperature
        if kw.get("seed") is None and self._seed is not None:
            kw["seed"] = self._seed
        if self._max_tokens is not None:
            want = kw.get("max_completion_tokens") or kw.get("max_tokens")
            kw["max_completion_tokens"] = (
                self._max_tokens if want is None else min(want, self._max_tokens)
            )
            kw.pop("max_tokens", None)
        if self._disable_thinking:
            kw.setdefault("extra_body", {})["chat_template_kwargs"] = {
                "enable_thinking": False
            }
        if self.is_mock:
            return self._mock_create(kw)
        started = time.monotonic()
        try:
            response = self._sdk.chat.completions.create(**kw)
        except Exception as exc:
            self._emit(
                kw["messages"], "", {"backend": "openai-chat"},
                latency_ms=int((time.monotonic() - started) * 1000),
                error={"kind": "request_failed", "message": str(exc)},
            )
            raise
        latency = int((time.monotonic() - started) * 1000)
        choice = response.choices[0]
        raw = choice.message.content or ""
        usage = response.usage
        # the llm.call records the reply verbatim (reasoning included); the caller
        # gets the cleaned text
        self._emit(
            kw["messages"], raw, {"backend": "openai-chat"},
            usage=None if usage is None else {
                "input_tokens": usage.prompt_tokens,
                "output_tokens": usage.completion_tokens,
            },
            latency_ms=latency,
            finish_reason=choice.finish_reason,
        )
        choice.message.content = strip_think(raw)
        return response

    # -- the mock backend -----------------------------------------------------

    def _default_mock_responder(self, messages: list[dict]) -> str:
        prompt = str((messages[-1] or {}).get("content", "")) if messages else ""
        return _MOCK_LINES[deterministic_pick(self._seed or 0, prompt,
                                              len(_MOCK_LINES))]

    def _mock_create(self, kw: dict) -> Any:
        text = self._mock_responder(kw.get("messages") or [])
        self._emit(kw.get("messages") or [], text, {"backend": "mock"},
                   finish_reason="stop")
        # the OpenAI response shape consumers read: choices[0].message.content
        return types.SimpleNamespace(
            choices=[types.SimpleNamespace(
                message=types.SimpleNamespace(role="assistant", content=text),
                finish_reason="stop",
            )],
            usage=None,
            model=self.served_model,
        )

    # -- event emission --------------------------------------------------------

    def _emit(
        self,
        messages: list[dict],
        text: str,
        params: dict[str, Any],
        *,
        usage: dict[str, Any] | None = None,
        latency_ms: int | None = None,
        finish_reason: str | None = None,
        error: dict[str, Any] | None = None,
    ) -> None:
        with self._count_lock:  # callers may fan out over a thread pool
            self.n_calls += 1
        llm_call(
            agent=self.agent,
            model=self.model_id,
            request={"messages": messages, "params": params},
            response=None if error else {
                "message": {"role": "assistant", "content": text},
                "finish_reason": finish_reason or "stop",
            },
            usage=usage,
            latency_ms=latency_ms,
            error=error,
        )
