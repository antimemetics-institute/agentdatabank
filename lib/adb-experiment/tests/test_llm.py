"""Capture must describe the effective SDK call, including provider evidence."""

from copy import deepcopy
import json
from types import SimpleNamespace

import pytest
from openai.types.chat import ChatCompletion

from adb_events.inspect_chat import ChatMessageAssistant, ContentReasoning, ContentText
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
    assert not {"params", "role", "cache", "instance_id", "repeat"} & event.keys()
    assert event["retries"] == 0
    assert event["input"][0]["content"] == "hello"
    assert event["call"]["request"]["temperature"] == 0.2
    assert event["call"]["request"]["max_completion_tokens"] == 80
    assert event["call"]["request"]["seed"] == 17
    assert event["call"]["response"] == original
    assert event["output"]["model"] == "alias-2026-09-16"
    assert event["call"]["response"]["system_fingerprint"] == "fp_123"
    assert ChatMessageAssistant.model_validate(event["output"]["choices"][0]["message"]).content == [
        ContentReasoning(reasoning="private"), ContentText(text="answer"),
    ]
    assert event["output"]["completion"] == "answer"
    assert result.choices[0].message.content == "answer"
    assert event["metadata"] is None
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
    assert event["metadata"] == {"test.context": {"phase": "first"}}


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
    assert event["metadata"] is None
    assert event["retries"] == 0


@pytest.mark.parametrize("mock", [True, False])
@pytest.mark.parametrize("text,content,returned", [
    ("answer", "answer", "answer"),
    ("<think>reasoning</think>answer", [ContentReasoning(reasoning="reasoning"), ContentText(text="answer")], "answer"),
    ("<think>x</think>\n\nAnswer: 5", [ContentReasoning(reasoning="x"), ContentText(text="\n\nAnswer: 5")], "\n\nAnswer: 5"),
    (" \n<think> x </think>\n ", [ContentReasoning(reasoning=" x "), ContentText(text=" \n\n ")], " \n\n "),
    ("<think>truncated\n", "<think>truncated\n", "<think>truncated\n"),
    ('<think mode="deep">reasoning\ncontinued</think>answer',
     [ContentReasoning(reasoning="reasoning\ncontinued"), ContentText(text="answer")], "answer"),
    ('<think mode="deep">truncated', '<think mode="deep">truncated', '<think mode="deep">truncated'),
    ("<think>reasoning</think>", [ContentReasoning(reasoning="reasoning"), ContentText(text="")], ""),
    ("</think>answer", "</think>answer", "</think>answer"),
    # Unmatched closing tags remain literal text. The former stripper removed
    # every closing tag, including these mid-prose and quoted occurrences.
    pytest.param("Before </think> after", "Before </think> after", "Before </think> after",
                 id="unmatched-close-mid-prose"),
    pytest.param("</think>", "</think>", "</think>", id="unmatched-close-only"),
    pytest.param("answer</think>", "answer</think>", "answer</think>",
                 id="unmatched-close-at-end"),
    pytest.param("A</think>B</think>C", "A</think>B</think>C", "A</think>B</think>C",
                 id="repeated-unmatched-closes"),
    pytest.param("Use `</think>` to close it.", "Use `</think>` to close it.", "Use `</think>` to close it.",
                 id="quoted-close-in-prose"),
    pytest.param("x</think>\n\nAnswer: 5", "x</think>\n\nAnswer: 5", "x</think>\n\nAnswer: 5",
                 id="implicit-opening-is-not-inferred"),
    pytest.param("<think>x</think>\n\nAnswer: 5</think>",
                 [ContentReasoning(reasoning="x"), ContentText(text="\n\nAnswer: 5</think>")],
                 "\n\nAnswer: 5</think>", id="extra-close-after-reasoning"),
    pytest.param("Before </think> <think>x</think> after",
                 [ContentReasoning(reasoning="x"), ContentText(text="Before </think>  after")],
                 "Before </think>  after", id="unmatched-close-before-valid-block"),
    pytest.param("Before <think>x</think> after",
                 [ContentReasoning(reasoning="x"), ContentText(text="Before  after")],
                 "Before  after", id="text-on-both-sides-of-reasoning"),
    pytest.param("<think>x</think>answer<think>cutoff",
                 [ContentReasoning(reasoning="x"), ContentText(text="answer<think>cutoff")],
                 "answer<think>cutoff", id="closed-then-unclosed-block"),
    pytest.param("<think>Answer: 5.", "<think>Answer: 5.", "<think>Answer: 5.",
                 id="unclosed-think-at-start"),
    pytest.param("\n<think>Answer: 5.", "\n<think>Answer: 5.", "\n<think>Answer: 5.",
                 id="unclosed-think-after-newline"),
    pytest.param("Answer: <think>5.", "Answer: <think>5.", "Answer: <think>5.",
                 id="unclosed-think-in-middle"),
    pytest.param("Answer: 5.<think>", "Answer: 5.<think>", "Answer: 5.<think>",
                 id="unclosed-think-at-end"),
    pytest.param("<thinking>x</thinking>y", "<thinking>x</thinking>y", "<thinking>x</thinking>y",
                 id="different-tag-stays-literal"),
    pytest.param("a<think>x</think>b", [ContentReasoning(reasoning="x"), ContentText(text="ab")],
                 "ab", id="surrounding-text-concatenated"),
    pytest.param('<think signature="s">x</think>y', [ContentReasoning(reasoning="x"), ContentText(text="y")],
                 "y", id="think-with-attributes"),
    pytest.param("<think>x</think>a<think>y</think>b",
                 [ContentReasoning(reasoning="x"), ContentText(text="a<think>y</think>b")],
                 "a<think>y</think>b", id="only-first-block-extracted"),
    (" answer ", " answer ", " answer "),
    ("Rating: 9\n\n", "Rating: 9\n\n", "Rating: 9\n\n"),
])
def test_reasoning_parts_determine_completion_and_returned_text(event_capture, mock, text, content, returned):
    client, reply = client_and_reply()
    client.is_mock = mock
    client._mock_responder = lambda messages: text
    reply.choices[0].message.content = text
    client._request = lambda kw: reply
    result = client.chat.completions.create(model="served", messages=[])
    [event] = event_capture.read()
    assert result.choices[0].message.content == returned
    assert ChatMessageAssistant.model_validate(event["output"]["choices"][0]["message"]).content == content
    assert event["output"]["completion"] == ChatMessageAssistant(content=content).text
    assert event["metadata"] is None
    if not mock:
        assert event["call"]["response"]["choices"][0]["message"]["content"] == text


@pytest.mark.parametrize("text", ["answer", " answer ", None])
def test_provider_reasoning_content_is_preserved_separately(event_capture, text):
    client, reply = client_and_reply()
    data = reply.model_dump(mode="json")
    data["choices"][0]["message"].update(content=text, reasoning_content="Consider the evidence")
    reply = ChatCompletion.model_validate(data)
    original = reply.model_dump(mode="json")
    client._request = lambda kw: reply
    result = client.chat.completions.create(model="served", messages=[])
    [event] = event_capture.read()
    expected = [ContentReasoning(reasoning="Consider the evidence")]
    if text:
        expected.append(ContentText(text=text))
    assert ChatMessageAssistant.model_validate(event["output"]["choices"][0]["message"]).content == expected
    assert event["output"]["completion"] == (text or "")
    assert result.choices[0].message.content == (text or "")
    assert event["call"]["response"] == original
    assert event["metadata"] is None


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
