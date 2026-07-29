"""The canonical provider registry (the adb-providers package): parsing and
validation hold the invariants consumers lean on."""

from adb_providers import MOCK_PREFIXES, PROVIDERS


def test_registry_shape():
    assert MOCK_PREFIXES == {"mock", "mockllm"}
    for name, provider in PROVIDERS.items():
        assert provider.api_key.name.endswith(("_API_KEY", "_TOKEN")), name
        assert provider.base_url.name.endswith("_BASE_URL"), name
    # the one annotation in the file: openai's key is optional (local
    # OpenAI-compatible servers ignore auth) — everything else's is required
    assert not PROVIDERS["openai"].api_key.required
    assert all(p.api_key.required for n, p in PROVIDERS.items() if n != "openai")
    # and its base default is a real runtime fallback, like the OpenAI SDK's own
    assert PROVIDERS["openai"].base_url.default == "https://api.openai.com/v1"
