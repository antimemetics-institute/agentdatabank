"""Capture must describe the effective SDK call, including provider evidence."""

from copy import deepcopy
import json
from types import SimpleNamespace

import pytest
from openai.types.chat import ChatCompletion

from adb_experiment.llm import ChatClient


def client_and_reply():
    client = ChatClient("mock/alias", temperature=0.2, seed=17, max_tokens=80)
    client.is_mock = False
    reply = ChatCompletion.model_validate(
        {
            "id": "call-123",
            "object": "chat.completion",
            "created": 123,
            "model": "alias-2026-09-16",
            "system_fingerprint": "fp_123",
            "choices": [
                {
                    "index": 0,
                    "finish_reason": "stop",
                    "message": {
                        "role": "assistant",
                        "content": "<think>private</think>answer",
                        "vendor_field": {"future": True},
                    },
                }
            ],
            "usage": {"prompt_tokens": 3, "completion_tokens": 5, "total_tokens": 8},
            "vendor_field": {"future": [None, 1]},
        }
    )
    return client, reply


def test_capture_matches_effective_sdk_request_and_original_response(event_capture):
    client, reply = client_and_reply()
    sent = {}
    original = reply.model_dump(mode="json")

    def request(kw):
        sent.update(deepcopy(kw))
        return reply

    client._request = request
    result = client.chat.completions.create(
        model="sent-model",
        messages=[{"role": "user", "content": "hello"}],
        temperature=0.9,
        top_p=0.8,
        max_tokens=100,
    )
    event = event_capture.read()[0]
    assert event["call"]["request"] == sent
    assert not {"params", "role", "retries", "cache", "instance_id", "repeat"} & event.keys()
    assert event["input"][0]["content"] == "hello"
    assert event["call"]["request"]["temperature"] == 0.2
    assert event["call"]["request"]["max_completion_tokens"] == 80
    assert event["call"]["request"]["seed"] == 17
    assert event["call"]["response"] == original
    assert event["output"]["model"] == "alias-2026-09-16"
    assert event["call"]["response"]["system_fingerprint"] == "fp_123"
    assert event["output"]["choices"][0]["message"]["content"] == original["choices"][0]["message"]["content"]
    assert result.choices[0].message.content == "answer"
    assert event["metadata"]["adb_experiment.returned_text_stripped"] is True
    assert event["output"]["usage"]["input_tokens"] == 3
    assert event["output"]["usage"]["output_tokens"] == 5



def test_failure_retains_effective_request(event_capture):
    client, _ = client_and_reply()
    client.metadata = {"test.phase": "harvest"}

    def fail(kw):
        raise RuntimeError("connection failed")

    client._request = fail
    with pytest.raises(RuntimeError, match="connection failed"):
        client.chat.completions.create(model="sent", messages=[], top_p=0.8)
    event = event_capture.read()[0]
    assert event["call"]["request"]["temperature"] == 0.2
    assert event["call"]["request"]["top_p"] == 0.8
    assert event["error"] == "connection failed"
    assert event["call"]["error"] is True
    assert event["output"]["choices"] == []
    assert event["call"]["response"] is None
    assert event["metadata"]["test.phase"] == "harvest"


def test_producer_metadata_is_snapshotted_and_stays_out_of_request(event_capture):
    client, reply = client_and_reply()
    client.metadata = {"test.context": {"phase": "first"}}

    def request(kw):
        assert "metadata" not in kw
        client.metadata["test.context"]["phase"] = "second"
        return reply

    client._request = request
    client.chat.completions.create(model="sent", messages=[])
    [event] = event_capture.read()
    assert event["metadata"]["test.context"] == {"phase": "first"}
    assert event["metadata"]["adb_experiment.backend"] == "openai-chat"


def test_mock_records_effective_parameters(event_capture):
    client = ChatClient("mock/model", seed=17, temperature=0.2, max_tokens=80)
    client.chat.completions.create(model="model", messages=[], max_tokens=100)
    event = event_capture.read()[0]
    assert event["call"]["request"] == {
        "model": "model", "messages": [],
        "seed": 17,
        "temperature": 0.2,
        "max_completion_tokens": 80,
    }
    assert event["metadata"]["adb_experiment.backend"] == "mock"


@pytest.mark.parametrize("mock", [True, False])
@pytest.mark.parametrize("text,returned", [
    ("answer", "answer"),
    ("<think>reasoning</think>answer", "answer"),
    ("<think>truncated", ""),
    ("</think>answer", "answer"),
    (" answer ", "answer"),
])
def test_stripping_flag_describes_returned_text_without_changing_evidence(event_capture, mock, text, returned):
    client, reply = client_and_reply()
    client.is_mock = mock
    client._mock_responder = lambda messages: text
    reply.choices[0].message.content = text
    client._request = lambda kw: reply
    result = client.chat.completions.create(model="served", messages=[])
    [event] = event_capture.read()
    assert result.choices[0].message.content == returned
    assert event["output"]["choices"][0]["message"]["content"] == text
    assert event["metadata"].get("adb_experiment.returned_text_stripped", False) == (text != returned)
    if not mock:
        assert event["call"]["response"]["choices"][0]["message"]["content"] == text


@pytest.mark.parametrize("thinking", [None, True, False])
def test_qwen_reasoning_settings_are_caller_owned(event_capture, monkeypatch, thinking):
    _, reply = client_and_reply()
    reply.model = "Qwen3-test"
    sent = {}

    def create(**kw):
        sent.update(deepcopy(kw))
        return reply

    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.setenv("OPENAI_BASE_URL", "http://localhost:1234/v1")
    monkeypatch.setattr(
        "openai.OpenAI",
        lambda **kw: SimpleNamespace(chat=SimpleNamespace(
            completions=SimpleNamespace(create=create))),
    )
    client = ChatClient("openai/Qwen3-test")
    request = {
        "model": client.served_model,
        "messages": [{"role": "user", "content": "hello"}],
    }
    if thinking is not None:
        request["extra_body"] = {
            "chat_template_kwargs": {"enable_thinking": thinking, "custom": "kept"},
        }
    original = deepcopy(request)
    client.chat.completions.create(**request)

    assert sent == original
    assert request == original
    event = event_capture.read()[0]
    assert event["call"]["request"] == original


def test_tools_multimodal_input_all_choices_and_cached_usage(event_capture):
    client, reply = client_and_reply()
    data = reply.model_dump(mode="json")
    data["choices"] = [{
        "index": 0, "finish_reason": "tool_calls", "message": {
            "role": "assistant", "content": None, "reasoning_content": "Consider the evidence",
            "tool_calls": [{"id": "tool-1", "type": "function", "function": {
                "name": "lookup", "arguments": '{"q":"hello"}',
            }}],
        }, "logprobs": {"content": [{"token": "lookup", "logprob": -0.5, "bytes": None, "top_logprobs": []}]},
    }, {"index": 1, "finish_reason": "length", "message": {"role": "assistant", "content": "Alternative"}}]
    data["usage"]["prompt_tokens_details"] = {"cached_tokens": 2}
    data["usage"]["completion_tokens_details"] = {"reasoning_tokens": 4}
    reply = ChatCompletion.model_validate(data)
    client._request = lambda kw: reply
    request = {
        "model": "served", "messages": [{"role": "developer", "content": "Be helpful"},
            {"role": "user", "content": [{"type": "text", "text": "What is this?"},
                {"type": "image_url", "image_url": {"url": "https://example.org/image.png", "detail": "low"}}]}],
        "tools": [{"type": "function", "function": {
            "name": "lookup", "description": "Find evidence", "parameters": {
                "type": "object", "properties": {"q": {"type": "string"}}, "required": ["q"],
            }, "strict": True,
        }}], "tool_choice": "required",
    }
    client.chat.completions.create(**request)
    event = event_capture.read()[0]
    assert event["input"][0]["role"] == "system"
    assert event["input"][1]["content"][1]["type"] == "image"
    assert event["tools"][0]["name"] == "lookup"
    assert event["tools"][0]["options"] == {"strict": True}
    assert event["tool_choice"] == "any"
    choices = event["output"]["choices"]
    assert choices[0]["message"]["content"][0]["type"] == "reasoning"
    assert choices[0]["message"]["tool_calls"][0]["arguments"] == {"q": "hello"}
    assert choices[0]["logprobs"]["content"][0]["token"] == "lookup"
    assert choices[1]["message"]["content"] == "Alternative"
    assert choices[1]["stop_reason"] == "max_tokens"
    assert event["output"]["usage"]["input_tokens"] == 1
    assert event["output"]["usage"]["input_tokens_cache_read"] == 2
    assert event["output"]["usage"]["reasoning_tokens"] == 4
    assert event["call"]["request"]["messages"] == request["messages"]
    assert event["call"]["response"]["choices"][0]["message"]["content"] is None


@pytest.mark.parametrize("arguments", ["not json", "[]"])
def test_malformed_tool_arguments_remain_observable(event_capture, arguments):
    client, reply = client_and_reply()
    data = reply.model_dump(mode="json")
    data["choices"][0]["message"]["tool_calls"] = [{
        "id": "bad", "type": "function", "function": {"name": "lookup", "arguments": arguments},
    }]
    client._request = lambda kw: ChatCompletion.model_validate(data)
    client.chat.completions.create(model="served", messages=[])
    event = event_capture.read()[0]
    assert event["output"]["choices"][0]["message"]["tool_calls"][0]["parse_error"]
    assert event["call"]["response"]["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"] == arguments
