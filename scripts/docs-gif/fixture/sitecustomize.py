"""Docs recording only: a genuine, deterministic Inspect mock response."""
from inspect_ai.model._providers.mockllm import MockLLM

MockLLM.default_output = "Hi! This model is ready to help. Here is my output."
