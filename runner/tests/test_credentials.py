"""Local credential store: resolution (which env to inject for a run's llm params),
storage (0600 toml), and the `adb-runner credentials` CLI."""

import io
import os
import stat

import pytest

from adb_runner import credentials


@pytest.fixture
def cfg(tmp_path, monkeypatch):
    path = tmp_path / "credentials.toml"
    monkeypatch.setenv("ADB_CREDENTIALS_FILE", str(path))
    return path


def test_save_load_roundtrip_is_0600(cfg):
    credentials.save({"openai": {"OPENAI_API_KEY": "sk-secret", "OPENAI_BASE_URL": "http://h/v1"}})
    assert credentials.load() == {
        "openai": {"OPENAI_API_KEY": "sk-secret", "OPENAI_BASE_URL": "http://h/v1"}
    }
    mode = stat.S_IMODE(os.stat(cfg).st_mode)
    assert mode == 0o600, oct(mode)


def test_missing_file_loads_empty(cfg):
    assert credentials.load() == {}


def _manifest(model_type):
    return {"name": "x", "params": {"model": {"type": model_type}}}


def test_env_for_run_resolves_bare_llm(cfg):
    credentials.save({"openai": {"OPENAI_BASE_URL": "http://llama/v1", "OPENAI_API_KEY": "k"}})
    manifest = _manifest({"kind": "llm"})
    env = credentials.env_for_run(manifest, {"model": "openai/qwen3.5-9b"})
    assert env == {"OPENAI_BASE_URL": "http://llama/v1", "OPENAI_API_KEY": "k"}


def test_mock_and_unconfigured_yield_nothing(cfg):
    credentials.save({"openai": {"OPENAI_API_KEY": "k"}})
    manifest = _manifest({"kind": "llm"})
    assert credentials.env_for_run(manifest, {"model": "mock/model"}) == {}
    # a set with no stored config contributes nothing
    assert credentials.env_for_run(manifest, {"model": "anthropic/claude"}) == {}


def test_resolves_llm_inside_list_of_struct(cfg):
    # werewolf shape: players = listOf (struct { model = llm; role = enum; })
    credentials.save({"anthropic": {"ANTHROPIC_API_KEY": "a"}, "openai": {"OPENAI_API_KEY": "o"}})
    manifest = {
        "name": "werewolf",
        "params": {
            "players": {
                "type": {
                    "kind": "list",
                    "of": {"kind": "struct", "fields": {
                        "model": {"kind": "llm"}, "role": {"kind": "enum", "values": ["x"]},
                    }},
                }
            }
        },
    }
    realized = {"players": [
        {"model": "openai/gpt", "role": "x"},
        {"model": "anthropic/claude", "role": "x"},
        {"model": "mock/a", "role": "x"},
    ]}
    env = credentials.env_for_run(manifest, realized)
    assert env == {"OPENAI_API_KEY": "o", "ANTHROPIC_API_KEY": "a"}


def test_resolves_param_wrapped_struct_field(cfg):
    # concordia shape: agents = listOf (struct { model = param llm { suggestions }; })
    # — the field is {"type": {...}, "suggestions": [...]}, not a bare type descriptor
    credentials.save({"openai": {"OPENAI_API_KEY": "k"}})
    manifest = {
        "name": "concordia",
        "params": {
            "agents": {
                "type": {
                    "kind": "list",
                    "of": {"kind": "struct", "fields": {
                        "name": {"kind": "str"},
                        "model": {"type": {"kind": "llm"}, "suggestions": ["mock/model"]},
                    }},
                }
            }
        },
    }
    realized = {"agents": [{"name": "A", "model": "openai/qwen3.5-9b"},
                           {"name": "B", "model": ""}]}
    assert credentials.env_for_run(manifest, realized) == {"OPENAI_API_KEY": "k"}


def test_openai_api_service_ids_route_to_named_section(cfg):
    # inspect's OpenAI-compatible services: openai-api/<service>/<model> reads
    # <SERVICE>_API_KEY/_BASE_URL — so a named credential set serves those ids,
    # letting a real vendor key and a self-hosted server coexist
    credentials.save({"llama": {"LLAMA_API_KEY": "k", "LLAMA_BASE_URL": "http://l/v1"},
                      "openai": {"OPENAI_API_KEY": "real"}})
    manifest = _manifest({"kind": "llm"})
    env = credentials.env_for_run(manifest, {"model": "openai-api/llama/qwen3.5-9b"})
    assert env == {"LLAMA_API_KEY": "k", "LLAMA_BASE_URL": "http://l/v1"}
    # a named service nobody configured is never gated (it may need nothing)
    assert credentials.missing_sets(manifest, {"model": "openai-api/other/m"}) == []
    assert credentials.section_for("openai-api/llama/qwen") == "llama"
    assert credentials.section_for("openai/gpt-4o") == "openai"
    assert credentials.section_for("mockllm/model") is None


def test_missing_sets_gate(cfg, monkeypatch):
    manifest = _manifest({"kind": "llm"})
    for var in ("OPENAI_API_KEY", "OPENAI_BASE_URL"):
        monkeypatch.delenv(var, raising=False)
    # built-in name, nothing configured anywhere → reported
    assert credentials.missing_sets(manifest, {"model": "openai/q"}) == ["openai"]
    # mocks (both spellings) route to no credential set
    assert credentials.missing_sets(manifest, {"model": "mock/model"}) == []
    assert credentials.missing_sets(manifest, {"model": "mockllm/model"}) == []
    # unknown prefix (a local ollama may legitimately need nothing) → never blocked
    assert credentials.missing_sets(manifest, {"model": "ollama/llama3"}) == []
    # a host env var does NOT satisfy the gate — the store is the only credential
    # source, and an accidentally exported key must not skip the setup prompt
    monkeypatch.setenv("OPENAI_API_KEY", "sk-ambient")
    assert credentials.missing_sets(manifest, {"model": "openai/q"}) == ["openai"]
    monkeypatch.delenv("OPENAI_API_KEY")
    # a stored section does
    credentials.save({"openai": {"OPENAI_API_KEY": "k"}})
    assert credentials.missing_sets(manifest, {"model": "openai/q"}) == []


def _cli(argv, stdin="", monkeypatch=None):
    import sys
    if monkeypatch is not None:
        monkeypatch.setattr(sys, "stdin", io.StringIO(stdin))
    return credentials.credentials_cli(argv)


def test_cli_set_via_stdin_then_list(cfg, monkeypatch, capsys):
    # interactive path reads a line per prompt from stdin (non-tty): key then base_url
    code = _cli(["set", "openai"], stdin="sk-topsecret\nhttp://llama/v1\n", monkeypatch=monkeypatch)
    assert code == 0
    assert credentials.load()["openai"] == {
        "OPENAI_API_KEY": "sk-topsecret", "OPENAI_BASE_URL": "http://llama/v1"
    }
    capsys.readouterr()
    assert _cli(["list"]) == 0
    out = capsys.readouterr().out
    # the secret value is never printed; the endpoint (non-secret) is shown
    assert "sk-topsecret" not in out
    assert "OPENAI_API_KEY=<set>" in out
    assert "http://llama/v1" in out


def test_cli_set_rejects_schemeless_base_url(cfg, monkeypatch, capsys):
    # a bare host would only fail later, inside a client ("unknown url type") — the
    # set command is where the fix is cheap, so it refuses and shows the shape
    code = _cli(["set", "openai"], stdin="sk-k\nllama.forest.local\n", monkeypatch=monkeypatch)
    assert code == 2
    assert credentials.load() == {}
    assert "http://llama.local:11434/v1" in capsys.readouterr().err


def test_cli_set_refuses_values_on_argv(cfg, capsys):
    # there deliberately is NO KEY=VALUE form: argv is visible in ps / shell history
    assert _cli(["set", "openai", "OPENAI_API_KEY=sk-leaked"]) == 2
    assert credentials.load() == {}
    assert "never taken on the command line" in capsys.readouterr().err


def test_cli_set_empty_prompt_adopts_base_url_default(cfg, monkeypatch):
    # key entered, base-url prompt left empty → the shown default is stored
    code = _cli(["set", "openai"], stdin="sk-k\n\n", monkeypatch=monkeypatch)
    assert code == 0
    assert credentials.load()["openai"] == {
        "OPENAI_API_KEY": "sk-k", "OPENAI_BASE_URL": "https://api.openai.com/v1"
    }


def test_cli_set_unknown_name_prompts_conventional_names(cfg, monkeypatch, capsys):
    code = _cli(["set", "myprov"], stdin="k-123\nhttps://my.host/v1\n", monkeypatch=monkeypatch)
    assert code == 0
    assert credentials.load()["myprov"] == {
        "MYPROV_API_KEY": "k-123", "MYPROV_BASE_URL": "https://my.host/v1"
    }


def test_cli_remove(cfg, monkeypatch, capsys):
    assert _cli(["set", "openai"], stdin="sk-k\nhttp://h/v1\n", monkeypatch=monkeypatch) == 0
    assert _cli(["remove", "openai"]) == 0
    assert credentials.load() == {}


def test_registry_base_urls_are_prompted_with_defaults(cfg, monkeypatch):
    # the canonical registry (registry.py) declares a base-URL var for every
    # built-in — key entered, base prompt left empty → the default origin is stored,
    # so a proxy/regional endpoint is one retype away without a config file edit
    code = _cli(["set", "groq"], stdin="gsk-k\n\n", monkeypatch=monkeypatch)
    assert code == 0
    assert credentials.load()["groq"] == {
        "GROQ_API_KEY": "gsk-k", "GROQ_BASE_URL": "https://api.groq.com/openai/v1"
    }
