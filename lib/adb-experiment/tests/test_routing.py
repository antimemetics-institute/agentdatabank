"""Exercise the actual SDK transport, retries, and model-identity boundary."""

from concurrent.futures import ThreadPoolExecutor
from threading import Barrier, Lock
import json

import httpx
import openai
import pytest

from adb_experiment.llm import ChatClient, ServedModelMismatch
from adb_experiment.providers import resolve
from adb_providers import served_model_matches
from test_llm import client_and_reply


def test_azure_resolution_requires_both_credentials():
    env = {"AZURE_OPENAI_API_KEY": "test-key", "AZURE_OPENAI_BASE_URL": "https://resource.openai.azure.com/openai/v1/"}
    endpoint = resolve("azure/gpt-5-nano", env)
    assert endpoint.served_model == "gpt-5-nano"
    assert endpoint.base_url == env["AZURE_OPENAI_BASE_URL"].rstrip("/")
    assert endpoint.api_key == "test-key"
    for key in env:
        with pytest.raises(ValueError, match=key):
            resolve("azure/gpt-5-nano", {k: v for k, v in env.items() if k != key})


@pytest.mark.parametrize("requested,served,matches", [
    ("azure/gpt-5-nano", "gpt-5-nano-2025-08-07", True),
    ("azure/DeepSeek-V4-Pro", "deepSEEK-v4-PRO-2026-09", True),
    ("openai/gpt-5-nano", "gpt-5-mini", False),
    ("openai-api/local/org/model", "org/model-snapshot", True),
    ("openrouter/org/model", "org/model", True),
    ("model", "model", True),
    ("azure/", "anything", False),
])
def test_served_model_identity(requested, served, matches):
    assert served_model_matches(requested, served) is matches


def test_first_success_records_mismatch_then_fails_without_harness_fallback(event_capture):
    client, reply = client_and_reply()
    reply.model = "wrong-model"
    client._request = lambda kw: reply
    original = reply.model_dump(mode="json")
    with pytest.raises(ServedModelMismatch, match="mock/alias.*wrong-model"):
        # A harness may recover ordinary API failures, but not a misrouted model.
        try:
            client.chat.completions.create(model="alias", messages=[])
        except Exception:
            pytest.fail("model mismatch was swallowed by a harness fallback")
    call, log = event_capture.read()
    assert call["type"] == "llm.call" and call["output"]["model"] == "wrong-model"
    assert call["call"]["response"] == original
    assert call.get("error") is None
    assert log["type"] == "log" and log["level"] == "error"
    assert "mock/alias" in log["message"] and "wrong-model" in log["message"]


def sdk_client(monkeypatch, handler):
    default_http = openai.DefaultHttpxClient

    def transport(**kw):
        return default_http(**kw, transport=httpx.MockTransport(handler))

    sdk_type = openai.OpenAI

    def sdk(**kw):
        assert kw["max_retries"] == 8
        assert kw["http_client"].timeout == openai.DEFAULT_TIMEOUT
        return sdk_type(**kw)

    monkeypatch.setattr(openai, "DefaultHttpxClient", transport)
    monkeypatch.setattr(openai, "OpenAI", sdk)
    monkeypatch.setattr(openai._base_client.BaseClient, "_calculate_retry_timeout", lambda *a, **kw: 0)
    monkeypatch.setenv("AZURE_OPENAI_API_KEY", "test-key")
    monkeypatch.setenv("AZURE_OPENAI_BASE_URL", "https://resource.openai.azure.com/openai/v1/")
    return ChatClient("azure/alias")


def test_sdk_retries_are_per_call_including_overlapping_calls(event_capture, monkeypatch):
    _, reply = client_and_reply()
    attempts = {}
    lock, barrier = Lock(), Barrier(2)

    def handler(request):
        assert request.url.path == "/openai/v1/chat/completions"
        assert request.headers["Authorization"] == "Bearer test-key"
        body = json.loads(request.content)
        assert body["model"] == "alias"
        name = body["messages"][0]["content"]
        with lock:
            attempts[name] = attempts.get(name, 0) + 1
            attempt = attempts[name]
        if attempt == 1 and name in {"retry", "clean"}:
            barrier.wait(timeout=5)
        code = [429, 503, 200][min(attempt - 1, 2)] if name == "retry" else 200
        return httpx.Response(code, json=reply.model_dump(mode="json") if code == 200 else {"error": {"message": "busy"}})

    client = sdk_client(monkeypatch, handler)
    def call(name):
        return client.chat.completions.create(model="alias", messages=[{"role": "user", "content": name}])
    with ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(call, ["retry", "clean"]))
    call("next")
    events = {e["call"]["request"]["messages"][0]["content"]: e for e in event_capture.read()}
    assert attempts == {"retry": 3, "clean": 1, "next": 1}
    assert events["retry"]["metadata"]["adb_experiment.retries"] == 2
    assert all("adb_experiment.retries" not in events[name]["metadata"] for name in ("clean", "next"))


def test_exhausted_retries_retained_and_do_not_consume_first_success_check(event_capture, monkeypatch):
    count = 0
    _, reply = client_and_reply()
    reply.model = "wrong-model"

    def handler(request):
        nonlocal count
        count += 1
        return httpx.Response(429, json={"error": {"message": "busy"}}) if count <= 9 else httpx.Response(200, json=reply.model_dump(mode="json"))

    client = sdk_client(monkeypatch, handler)
    with pytest.raises(openai.RateLimitError):
        client.chat.completions.create(model="alias", messages=[])
    with pytest.raises(ServedModelMismatch):
        client.chat.completions.create(model="alias", messages=[])
    failure, success, log = event_capture.read()
    assert failure["metadata"]["adb_experiment.retries"] == 9
    assert failure["error"] and failure["call"]["error"]
    assert failure["output"]["model"] == ""
    assert "adb_experiment.retries" not in success["metadata"]
    assert log["level"] == "error"
