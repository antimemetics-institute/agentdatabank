"""Local provider credentials & endpoints — secrets and base URLs for real models, kept
out of experiment params and off the command line.

The split (specs/comparability.md): a model *name* is the condition (a `param llm`, e.g.
``openai/qwen3.5-9b``); *where* it is served and *which key* reaches it are environment,
not a condition. So the runner resolves each `llm`-typed param's provider — the segment
before the first ``/`` — and injects that provider's stored env vars (``OPENAI_API_KEY``,
``OPENAI_BASE_URL``, …) into the experiment subprocess. Experiments read the standard env
var names they already use (litellm / inspect_ai / concordia's client all do); they never
see this module.

Storage: ``~/.config/adb/credentials.toml`` (0600), one section per provider mapping env var
→ value. Managed with ``adb-runner credentials set <provider>``, which prompts for every
value — secrets via a hidden prompt, NEVER argv (argv is visible in ``ps`` and shell
history, so there deliberately is no ``KEY=VALUE`` form). Scripted use pipes one line
per prompt on stdin.
"""

from __future__ import annotations

import getpass
import os
import re
import sys
import tomllib
from pathlib import Path

# Known providers and the env vars each uses: (var, secret, default). secret = hidden
# prompt; default (non-secret vars only) is adopted when the prompt is left empty and
# nothing is stored yet.
REGISTRY: dict[str, list[tuple[str, bool, str | None]]] = {
    "openai": [("OPENAI_API_KEY", True, None),
               ("OPENAI_BASE_URL", False, "https://api.openai.com/v1")],
    "anthropic": [("ANTHROPIC_API_KEY", True, None),
                  ("ANTHROPIC_BASE_URL", False, "https://api.anthropic.com")],
    "gemini": [("GEMINI_API_KEY", True, None)],
    "google": [("GOOGLE_API_KEY", True, None)],
    "groq": [("GROQ_API_KEY", True, None)],
    "mistral": [("MISTRAL_API_KEY", True, None)],
    "grok": [("GROK_API_KEY", True, None)],
    "moonshotai": [("MOONSHOTAI_API_KEY", True, None),
                   ("MOONSHOTAI_BASE_URL", False, "https://api.moonshot.ai/v1")],
    "openrouter": [("OPENROUTER_API_KEY", True, None),
                   ("OPENROUTER_BASE_URL", False, "https://openrouter.ai/api/v1")],
    "azureai": [("AZUREAI_API_KEY", True, None),
                ("AZUREAI_BASE_URL", False, None)],
}

# prefixes that mean "keyless built-in mock" (adb experiments use mock/, inspect's own
# is mockllm/) — they reference no provider and never need credentials
MOCK_PREFIXES = {"mock", "mockllm"}


def config_path() -> Path:
    override = os.environ.get("ADB_CREDENTIALS_FILE")
    if override:
        return Path(override)
    base = os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config")
    return Path(base) / "adb" / "credentials.toml"


def load() -> dict[str, dict[str, str]]:
    path = config_path()
    if not path.exists():
        return {}
    with open(path, "rb") as f:
        data = tomllib.load(f)
    return {
        provider: {k: str(v) for k, v in vals.items()}
        for provider, vals in data.items()
        if isinstance(vals, dict)
    }


def _toml_escape(value: str) -> str:
    return (
        value.replace("\\", "\\\\").replace('"', '\\"')
        .replace("\n", "\\n").replace("\t", "\\t")
    )


def save(data: dict[str, dict[str, str]]) -> Path:
    path = config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = [
        "# ADB provider credentials & endpoints — managed by `adb-runner credentials`.",
        "# Secrets live here (0600), never in experiment params or on the command line.",
        "",
    ]
    for provider in sorted(data):
        vals = {k: v for k, v in data[provider].items() if v != ""}
        if not vals:
            continue
        lines.append(f"[{provider}]")
        for key in sorted(vals):
            lines.append(f'{key} = "{_toml_escape(str(vals[key]))}"')
        lines.append("")
    # create with 0600 from the start (don't briefly expose secrets at default umask)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write("\n".join(lines))
    os.chmod(path, 0o600)
    return path


# -- resolution (used by the runner before launching an experiment) --------------------

def _iter_model_ids(value, tdesc: dict):
    """Yield every model-id string sitting at an `llm`-typed position in a realized value
    (handles bare llm, listOf llm, and structs/lists nesting llm — e.g. werewolf's
    players = listOf (struct { model = llm; }))."""
    kind = (tdesc or {}).get("kind")
    if kind == "llm":
        if isinstance(value, str):
            yield value
    elif kind == "list" and isinstance(value, list):
        for item in value:
            yield from _iter_model_ids(item, tdesc.get("of") or {})
    elif kind == "struct" and isinstance(value, dict):
        from .schema import field_type  # param-wrapped struct fields carry hints
        for fname, ftype in (tdesc.get("fields") or {}).items():
            if fname in value:
                yield from _iter_model_ids(value[fname], field_type(ftype))


def section_for(model_id: str) -> str | None:
    """The credential-store section a model id routes to. Normally the prefix before
    the first `/`; for inspect's OpenAI-compatible services — `openai-api/<service>/
    <model>`, which read `<SERVICE>_API_KEY` / `<SERVICE>_BASE_URL` — it is the
    *service* segment, so a named credential set (e.g. `credentials set llama`) serves
    exactly the ids that name it. Mocks route nowhere."""
    head, sep, rest = model_id.partition("/")
    if not sep or not head or head in MOCK_PREFIXES:
        return None
    if head == "openai-api":
        service, _, _ = rest.partition("/")
        return service or None
    return head


def providers_used(manifest: dict, realized_params: dict) -> set[str]:
    """The credential sections referenced by this run's `llm` params (mocks excluded)."""
    schema = manifest.get("params") or {}
    used: set[str] = set()
    for name, pschema in schema.items():
        if name not in realized_params:
            continue
        tdesc = pschema.get("type") or {"kind": pschema.get("kind", "str")}
        for model_id in _iter_model_ids(realized_params[name], tdesc):
            section = section_for(model_id)
            if section:
                used.add(section)
    return used


def env_for_run(manifest: dict, realized_params: dict) -> dict[str, str]:
    """Stored env vars to inject for the providers this run's models reference."""
    store = load()
    env: dict[str, str] = {}
    for provider in providers_used(manifest, realized_params):
        env.update(store.get(provider, {}))
    return env


def missing_providers(manifest: dict, realized_params: dict) -> list[str]:
    """Providers this run's model ids reference that are configured NOWHERE — no
    section in the store, none of their env vars in the host env. Only providers the
    REGISTRY knows need credentials are reported: an unknown prefix (ollama, vllm, a
    local server) may legitimately need nothing, and blocking on a guess would be
    inferred-but-wrong. A run naming a known provider with zero configuration can
    only fail, so the runner refuses it up front with the fix in hand."""
    store = load()
    out = []
    for provider in sorted(providers_used(manifest, realized_params)):
        if provider not in REGISTRY or provider in store:
            continue
        if any(os.environ.get(var) for var, _secret, _default in REGISTRY[provider]):
            continue
        out.append(provider)
    return out


# -- the `adb-runner credentials` CLI ----------------------------------------------------

def _is_secret(provider: str, key: str) -> bool:
    for k, secret, _default in REGISTRY.get(provider, []):
        if k == key:
            return secret
    return key.endswith("_KEY") or key.endswith("_TOKEN") or "SECRET" in key


def _url_problem(key: str, value: str) -> str | None:
    """A base-URL env var must be a full http(s) URL. A bare host fails inside every
    client — urllib raises "unknown url type", SDKs hang against the wrong port — long
    after this command succeeded, so catch it here where the fix is one retype. Empty
    passes (it clears the key). Returns the complaint, or None if the value is fine."""
    if not value or not (key.endswith("_BASE_URL") or key.endswith("_API_BASE")):
        return None
    if not value.startswith(("http://", "https://")):
        return (
            f"{key} must be a full URL including scheme (and port + path prefix where "
            f"the server needs them, e.g. http://llama.local:11434/v1) — got {value!r}"
        )
    return None


def _read(prompt: str, secret: bool) -> str:
    if sys.stdin.isatty():
        return (getpass.getpass(prompt) if secret else input(prompt)).strip()
    # non-interactive (scripted/tests): read a line from stdin, echo the prompt to stderr
    sys.stderr.write(prompt + "\n")
    sys.stderr.flush()
    return sys.stdin.readline().rstrip("\n")


def _cmd_list() -> int:
    store = load()
    if not store:
        print(f"no credentials configured ({config_path()})")
        return 0
    for provider in sorted(store):
        vals = store[provider]
        shown = ", ".join(
            f"{k}=<set>" if _is_secret(provider, k) else f"{k}={vals[k]}"
            for k in sorted(vals)
        )
        print(f"{provider}: {shown}")
    return 0


def prompt_provider(provider: str) -> int:
    """Prompt for a provider's values and save them — the ONE path a credential ever
    enters the store by: the CLI `set`, and the runner's ask-on-first-use. Secrets are
    hidden; non-secret prompts show the stored value or the known default (Enter
    adopts it). Scripted use pipes one line per prompt on stdin (non-tty)."""
    spec = REGISTRY.get(provider)
    if spec is None:
        # not a built-in: a NAMED credential set with the conventional env vars — the
        # same *_API_KEY / *_BASE_URL patterns the injection allowlist forwards, and
        # exactly what `openai-api/<name>/<model>` ids read
        prefix = re.sub(r"[^A-Za-z0-9]+", "_", provider).upper()
        spec = [(f"{prefix}_API_KEY", True, None), (f"{prefix}_BASE_URL", False, None)]
        print(f"{provider!r} isn't a built-in provider (built-ins: "
              f"{', '.join(sorted(REGISTRY))}) — storing it as a named credential set "
              f"({prefix}_API_KEY / {prefix}_BASE_URL); model ids reach it as "
              f"openai-api/{provider}/<model>. Leave a prompt empty to skip it.",
              file=sys.stderr)
    store = load()
    vals = dict(store.get(provider, {}))
    for key, secret, default in spec:
        current = vals.get(key, "")
        if secret:
            state = "<set>" if current else "unset"
        else:
            state = current or (f"default: {default}" if default else "unset")
        while True:
            entered = _read(f"{key} [{state}]: ", secret)
            if not entered and not current and default and not secret:
                entered = default  # empty prompt adopts the shown default
            problem = _url_problem(key, entered)
            if problem is None:
                break
            print(problem, file=sys.stderr)
            if not sys.stdin.isatty():
                return 2  # scripted input can't retype — fail rather than desync
        if entered:
            vals[key] = entered
    store[provider] = vals
    path = save(store)
    print(f"saved provider {provider!r} -> {path}")
    return 0


def _cmd_set(argv: list[str]) -> int:
    # values are ONLY ever prompted (or piped line-per-prompt on stdin): a KEY=VALUE
    # argv form would put secrets in `ps` output and shell history, so it doesn't exist
    if len(argv) != 1:
        print("usage: adb-runner credentials set <provider>\n"
              "values are prompted (secrets hidden), never taken on the command line —\n"
              "argv is visible in `ps` and shell history. Scripts pipe one line per "
              "prompt on stdin.", file=sys.stderr)
        return 2
    return prompt_provider(argv[0])


def _cmd_remove(argv: list[str]) -> int:
    if not argv:
        print("usage: adb-runner credentials remove <provider>", file=sys.stderr)
        return 2
    store = load()
    if argv[0] not in store:
        print(f"provider {argv[0]!r} not configured", file=sys.stderr)
        return 1
    del store[argv[0]]
    save(store)
    print(f"removed provider {argv[0]!r}")
    return 0


def credentials_cli(argv: list[str]) -> int:
    """`adb-runner credentials <list|set|remove|path>` — manage local model credentials."""
    if not argv or argv[0] in ("-h", "--help"):
        print(
            "adb-runner credentials — local model credentials & endpoints\n\n"
            "  list                show configured credential sets\n"
            "  set <provider>      add/update a provider — every value is prompted\n"
            "                      (secrets hidden; never on the command line)\n"
            "  remove <provider>   delete a provider\n"
            "  path                print the config file path\n"
        )
        return 0 if argv else 2
    cmd, rest = argv[0], argv[1:]
    if cmd == "list":
        return _cmd_list()
    if cmd == "set":
        return _cmd_set(rest)
    if cmd == "remove":
        return _cmd_remove(rest)
    if cmd == "path":
        print(config_path())
        return 0
    print(f"unknown credentials command {cmd!r}", file=sys.stderr)
    return 2
