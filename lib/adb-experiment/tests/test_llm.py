"""Capture must describe the effective SDK call, including provider evidence."""

from copy import deepcopy
import json

import pytest
from openai.types.chat import ChatCompletion

from adb_experiment.llm import ChatClient


def client_and_reply():
    client = ChatClient("mock/alias", temperature=0.2, seed=17, max_tokens=80)
    client.is_mock = False
    client._disable_thinking = True
    reply = ChatCompletion.model_validate(
        {
            "id": "call-123",
            "object": "chat.completion",
            "created": 123,
            "model": "resolved-model",
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
    assert event["request"] == {
        "messages": sent["messages"],
        "model": sent["model"],
        "params": {k: v for k, v in sent.items() if k not in ("messages", "model")},
        "raw": None,
    }
    assert event["request"]["params"]["temperature"] == 0.2
    assert event["request"]["params"]["max_completion_tokens"] == 80
    assert event["request"]["params"]["seed"] == 17
    assert event["response"]["raw"] == original
    assert event["response"]["model"] == "resolved-model"
    assert event["response"]["raw"]["system_fingerprint"] == "fp_123"
    assert event["response"]["message"] == original["choices"][0]["message"]
    assert result.choices[0].message.content == "answer"
    assert event["usage"] == {"input_tokens": 3, "output_tokens": 5}


def test_failure_retains_effective_request(event_capture):
    client, _ = client_and_reply()

    def fail(kw):
        raise RuntimeError("connection failed")

    client._request = fail
    with pytest.raises(RuntimeError, match="connection failed"):
        client.chat.completions.create(model="sent", messages=[], top_p=0.8)
    event = event_capture.read()[0]
    assert event["request"]["params"]["temperature"] == 0.2
    assert event["request"]["params"]["top_p"] == 0.8
    assert event["error"] == {"kind": "request_failed", "message": "connection failed"}
    assert event["response"] is None


def test_mock_records_effective_parameters(event_capture):
    client = ChatClient("mock/model", seed=17, temperature=0.2, max_tokens=80)
    client.chat.completions.create(model="model", messages=[], max_tokens=100)
    event = event_capture.read()[0]
    assert event["request"]["params"] == {
        "seed": 17,
        "temperature": 0.2,
        "max_completion_tokens": 80,
    }
    assert event["meta"]["backend"] == "mock"
