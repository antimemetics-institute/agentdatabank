"""Local credential store — secrets and base URLs for real models, kept out of
experiment params and off the command line.

The split (docs/plan/comparability.md): a model *name* is the condition (a `param llm`,
e.g. ``openai/qwen3.5-9b``); *where* it is served and *which key* reaches it are
environment, not a condition. So the runner resolves each `llm`-typed param's provider
prefix — the segment before the first ``/`` — to a credential set and injects that set's
stored env vars (``OPENAI_API_KEY``, ``OPENAI_BASE_URL``, …) into the experiment
subprocess. Experiments read the standard env var names they already use (litellm /
inspect_ai / concordia's client all do); they never see this module.

Storage: ``~/.config/adb/credentials.toml`` (0600). A credential set holds one or more
named PROFILES — ``[openai.default]``, ``[openai.work]`` — each an atomic free-form
field map (env var → value; no field-level fallback between profiles). The default
profile is used silently; named profiles are offered at an interactive picker, and a
choice can be remembered per experiment in ``~/.config/adb/preferences.toml`` (names
only — never secret, so not 0600). Managed with ``adb-runner credentials set
<name>[.<profile>]``, which prompts for every value — secrets via a hidden prompt,
NEVER argv (argv is visible in ``ps`` and shell history, so there deliberately is no
``KEY=VALUE`` form). Scripted use pipes one line per prompt on stdin.
"""

from __future__ import annotations

import getpass
import os
import re
import stat
import sys
import tomllib
from collections.abc import Collection
from pathlib import Path

# Built-in names come from the canonical provider registry (the adb-providers
# package). Here they are prompt templates only — no routing semantics.
from adb_providers import MOCK_PREFIXES, PROVIDERS

_PROFILE_RE = re.compile(r"[a-z0-9][a-z0-9_-]*\Z")
_RESERVED_PROFILES = {"new"}  # picker keyword


def config_path() -> Path:
    override = os.environ.get("ADB_CREDENTIALS_FILE")
    if override:
        return Path(override)
    base = os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config")
    return Path(base) / "adb" / "credentials.toml"


def prefs_path() -> Path:
    override = os.environ.get("ADB_PREFERENCES_FILE")
    if override:
        return Path(override)
    base = os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config")
    return Path(base) / "adb" / "preferences.toml"


def load() -> dict[str, dict[str, dict[str, str]]]:
    """set name -> profile name -> env var -> value.

    A bare value directly in a set's section (the pre-profiles flat layout) reads as
    a field of the ``default`` profile — the two shapes are structurally distinct in
    TOML, so no guessing is involved. Writes always produce explicit profiles.

    A store readable by group or others is REFUSED, not warned about (ssh/pgpass
    precedent): every other path here keeps secrets unexposed, and reading a leaky
    file would quietly tolerate the one exposure that matters. Uniform rule — CI
    materializing the file adds one chmod. Non-regular files (a process-substitution
    pipe) are exempt: their permission bits are meaningless."""
    path = config_path()
    if not path.exists():
        return {}
    mode = os.stat(path).st_mode
    if stat.S_ISREG(mode) and mode & 0o077:
        raise ValueError(
            f"{path} is readable by group/others (mode {oct(mode & 0o777)}) — "
            f"refusing to use it; fix with: chmod 600 {path}")
    with open(path, "rb") as f:
        data = tomllib.load(f)
    store: dict[str, dict[str, dict[str, str]]] = {}
    for name, section in data.items():
        if not isinstance(section, dict):
            continue
        profiles: dict[str, dict[str, str]] = {}
        for key, value in section.items():
            if isinstance(value, dict):
                profiles.setdefault(key, {}).update(
                    {k: str(v) for k, v in value.items()})
            else:
                profiles.setdefault("default", {})[key] = str(value)
        profiles = {p: vals for p, vals in profiles.items() if vals}
        if profiles:
            store[name] = profiles
    return store


def _toml_escape(value: str) -> str:
    return (
        value.replace("\\", "\\\\").replace('"', '\\"')
        .replace("\n", "\\n").replace("\t", "\\t")
    )


def save(data: dict[str, dict[str, dict[str, str]]]) -> Path:
    path = config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = [
        "# ADB credentials & endpoints — managed by `adb-runner credentials`.",
        "# Secrets live here (0600), never in experiment params or on the command line.",
        "# [<set>.<profile>] — the default profile is used silently; named profiles",
        "# are offered at the picker. Extra vars added by hand are injected too.",
        "",
    ]
    for name in sorted(data):
        for profile in sorted(data[name]):
            vals = {k: v for k, v in data[name][profile].items() if v != ""}
            if not vals:
                continue
            lines.append(f"[{name}.{profile}]")
            for key in sorted(vals):
                lines.append(f'{key} = "{_toml_escape(str(vals[key]))}"')
            lines.append("")
    # create with 0600 from the start (don't briefly expose secrets at default umask)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write("\n".join(lines))
    os.chmod(path, 0o600)
    return path


def _load_prefs() -> dict[str, dict[str, str]]:
    """experiment name -> set name -> profile name (names only, never values)."""
    path = prefs_path()
    if not path.exists():
        return {}
    with open(path, "rb") as f:
        data = tomllib.load(f)
    return {
        exp: {s: str(p) for s, p in choices.items() if not isinstance(p, dict)}
        for exp, choices in data.items()
        if isinstance(choices, dict)
    }


def _save_prefs(prefs: dict[str, dict[str, str]]) -> Path:
    path = prefs_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = [
        "# ADB per-experiment credential choices — profile NAMES only, no secrets.",
        "# Written by the `always use ...?` prompt; edit or delete lines freely.",
        "",
    ]
    for exp in sorted(prefs):
        if not prefs[exp]:
            continue
        lines.append(f'["{_toml_escape(exp)}"]')
        for s in sorted(prefs[exp]):
            lines.append(f'{s} = "{_toml_escape(prefs[exp][s])}"')
        lines.append("")
    path.write_text("\n".join(lines))
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
    """The credential set a model id routes to. Normally the provider prefix before
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


def sets_used(manifest: dict, realized_params: dict) -> set[str]:
    """The credential sets referenced by this run's `llm` params (mocks excluded)."""
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


def env_for_run(manifest: dict, realized_params: dict,
                selections: dict[str, str] | None = None) -> dict[str, str]:
    """Stored env vars to inject for the credential sets this run's models route to.
    `selections` maps set -> profile (from the interactive ladder); an unselected set
    uses its default profile. Profiles are atomic — no field-level fallback."""
    store = load()
    env: dict[str, str] = {}
    for name in sets_used(manifest, realized_params):
        profile = (selections or {}).get(name, "default")
        env.update(store.get(name, {}).get(profile, {}))
    return env


def missing_sets(manifest: dict, realized_params: dict) -> list[str]:
    """Credential sets this run's model ids route to with no section in the store. The
    store is the ONLY source of credentials — a key exported in the shell neither
    reaches a run nor suppresses this gate (it would silently skip the setup prompt
    while the run still launched keyless). Only built-in names the registry knows need
    credentials are reported: an unknown prefix (ollama, vllm, a local server) may
    legitimately need nothing, and blocking on a guess would be inferred-but-wrong.
    A run naming a built-in with zero configuration can only fail, so the runner
    refuses it up front with the fix in hand."""
    store = load()
    return [
        name
        for name in sorted(sets_used(manifest, realized_params))
        if name in PROVIDERS and name not in store
    ]


# -- the interactive ladder (used by the runner CLI once per invocation) ---------------

def resolve_run_credentials(manifest: dict, realized_params: dict, *,
                            experiment: str, interactive: bool) -> dict[str, str]:
    """The env to inject for this run, resolving a profile for every credential set
    the run routes to. Interactively this may prompt: first-use setup (with the
    save/[Y/n] and profile-name questions) for unconfigured built-ins, and the
    profile picker (with the remember question) for sets with named profiles.
    Headless it never prompts: remembered choice, else default profile, else raises
    ValueError with the fix. Values never touch argv anywhere on these paths —
    scripted input pipes one line per prompt on stdin."""
    missing = missing_sets(manifest, realized_params)
    if missing and not interactive:
        raise ValueError(
            f"this run needs credential set(s) {missing} but none are "
            f"configured — run `nix run .#adb-runner -- credentials set "
            f"{missing[0]}` (scripts pipe one line per prompt on stdin; "
            f"exported env vars are never read)")
    store = load()
    prefs = _load_prefs()
    env: dict[str, str] = {}
    for name in sorted(sets_used(manifest, realized_params)):
        profiles = store.get(name)
        if not profiles:
            if name not in PROVIDERS:
                continue  # unknown prefix (a local server) may legitimately need nothing
            print(f"adb: this run needs credential set {name!r} — setting it up now "
                  f"(stored 0600 in {config_path()}; change later with "
                  f"`nix run .#adb-runner -- credentials set {name}`)", file=sys.stderr)
            env.update(_first_use(name))
            continue
        profile = _pick_profile(name, profiles, experiment=experiment,
                                interactive=interactive, prefs=prefs)
        env.update(profiles[profile])
    return env


def _first_use(name: str) -> dict[str, str]:
    """Interactive first-use setup: prompt the template's values, offer to save.
    Declining still feeds the values to THIS run — they are returned either way."""
    vals = _prompt_values(name, current=None)
    if vals is None:
        raise ValueError(f"invalid input while setting up credential set {name!r}")
    answer = _read(f"save {name!r} for future runs? [Y/n]: ", False).lower()
    if answer in ("", "y", "yes"):
        profile = _prompt_profile_name(suggestion="default")
        if profile is None:
            raise ValueError("invalid profile name")
        store = load()
        store.setdefault(name, {})[profile] = vals
        path = save(store)
        print(f"saved credential set '{name}.{profile}' -> {path}", file=sys.stderr)
    return vals


def _pick_profile(name: str, profiles: dict[str, dict[str, str]], *,
                  experiment: str, interactive: bool,
                  prefs: dict[str, dict[str, str]]) -> str:
    """The per-set ladder: remembered choice -> lone default -> picker (interactive)
    or default-else-refuse (headless). May write a remembered choice to prefs."""
    remembered = (prefs.get(experiment) or {}).get(name)
    if remembered is not None:
        if remembered in profiles:
            print(f"adb: {name!r} credentials: {remembered!r} (remembered for "
                  f"{experiment!r}; edit {prefs_path()} to change)", file=sys.stderr)
            return remembered
        print(f"adb: remembered {name!r} profile {remembered!r} for {experiment!r} "
              f"no longer exists — asking again", file=sys.stderr)
    names = sorted(profiles)
    if names == ["default"]:
        return "default"
    if not interactive:
        if "default" in profiles:
            return "default"
        raise ValueError(
            f"credential set {name!r} has profiles {names} but no 'default' and no "
            f"remembered choice for {experiment!r} — run interactively once to "
            f"choose, or `credentials set {name}.default` to create a default")
    has_default = "default" in profiles
    others = [n for n in names if n != "default"]
    menu = ("[default] " if has_default else "") + " ".join(others + ["new"])
    while True:
        answer = _read(f"which {name!r} credentials? {menu}: ", False)
        if not answer:
            if has_default:
                choice = "default"
                break
            print(f"pick one of: {menu}", file=sys.stderr)
            if not sys.stdin.isatty():
                raise ValueError(f"credential set {name!r} needs a choice of: {menu}")
            continue
        if answer in profiles:
            choice = answer
            break
        if answer == "new":
            vals = _prompt_values(name, current=None)
            profile = _prompt_profile_name(suggestion=None, taken=set(profiles))
            if vals is None or profile is None:
                raise ValueError(f"invalid input while creating a {name!r} profile")
            store = load()
            store.setdefault(name, {})[profile] = vals
            save(store)
            profiles[profile] = vals
            choice = profile
            break
        print(f"no {name!r} profile {answer!r} (choices: {menu})", file=sys.stderr)
        if not sys.stdin.isatty():
            raise ValueError(f"no {name!r} profile {answer!r}")
    remember = _read(f"always use {choice!r} for {experiment!r}? [y/N]: ", False)
    if remember.lower() in ("y", "yes"):
        prefs.setdefault(experiment, {})[name] = choice
        path = _save_prefs(prefs)
        print(f"remembered ({path}); forget by editing that file", file=sys.stderr)
    return choice


# -- the `adb-runner credentials` CLI --------------------------------------------------

def _is_secret(name: str, key: str) -> bool:
    provider = PROVIDERS.get(name)
    if provider is not None:
        if key == provider.api_key.name:
            return True
        if key == provider.base_url.name:
            return False
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


def _template_rows(name: str) -> tuple[tuple[str, bool, str], ...]:
    """The prompt rows for a set, key first: (env var, secret?, prompt default)."""
    provider = PROVIDERS.get(name)
    if provider is not None:
        return ((provider.api_key.name, True, ""),
                (provider.base_url.name, False, provider.base_url.default))
    # not a built-in: a NAMED credential set with the conventional env var names —
    # exactly what `openai-api/<name>/<model>` ids read
    prefix = re.sub(r"[^A-Za-z0-9]+", "_", name).upper()
    print(f"{name!r} isn't a built-in name (built-ins: "
          f"{', '.join(sorted(PROVIDERS))}) — storing it as a named credential set "
          f"({prefix}_API_KEY / {prefix}_BASE_URL); model ids reach it as "
          f"openai-api/{name}/<model>. Leave a prompt empty to skip it.",
          file=sys.stderr)
    return ((f"{prefix}_API_KEY", True, ""), (f"{prefix}_BASE_URL", False, ""))


def _prompt_values(name: str, current: dict[str, str] | None) -> dict[str, str] | None:
    """Prompt a set's template values. Secrets are hidden; non-secret prompts show
    the current value or the known default (Enter adopts it). Returns None when
    scripted input can't satisfy validation (a retype needs a human)."""
    vals = dict(current or {})
    for var, secret, default in _template_rows(name):
        existing = vals.get(var, "")
        if secret:
            state = "<set>" if existing else "unset"
        else:
            state = existing or (f"default: {default}" if default else "unset")
        while True:
            entered = _read(f"{var} [{state}]: ", secret)
            if not entered and not existing and default and not secret:
                entered = default  # empty prompt adopts the shown default
            problem = _url_problem(var, entered)
            if problem is None:
                break
            print(problem, file=sys.stderr)
            if not sys.stdin.isatty():
                return None  # scripted input can't retype — fail rather than desync
        if entered:
            vals[var] = entered
    return vals


def _prompt_profile_name(*, suggestion: str | None,
                         taken: Collection[str] = frozenset()) -> str | None:
    state = f" [{suggestion}]" if suggestion else ""
    while True:
        entered = _read(f"name this profile{state}: ", False) or (suggestion or "")
        if entered in _RESERVED_PROFILES or not _PROFILE_RE.match(entered):
            print(f"profile names are [a-z0-9_-], lowercase, not "
                  f"{sorted(_RESERVED_PROFILES)} — got {entered!r}", file=sys.stderr)
        elif entered in taken:
            print(f"profile {entered!r} already exists", file=sys.stderr)
        else:
            return entered
        if not sys.stdin.isatty():
            return None  # scripted input can't retype — fail rather than desync


def _cmd_list() -> int:
    store = load()
    if not store:
        print(f"no credentials configured ({config_path()})")
        return 0
    for name in sorted(store):
        for profile in sorted(store[name]):
            vals = store[name][profile]
            shown = ", ".join(
                f"{k}=<set>" if _is_secret(name, k) else f"{k}={vals[k]}"
                for k in sorted(vals)
            )
            print(f"{name}.{profile}: {shown}")
    return 0


def prompt_set(arg: str) -> int:
    """`credentials set <name>` prompts values then a profile name ([default]);
    `credentials set <name>.<profile>` targets that profile directly — the ONE path
    a credential ever enters the store by, besides the runner's ask-on-first-use.
    Scripted use pipes one line per prompt on stdin (non-tty)."""
    name, dot, profile = arg.partition(".")
    if dot and (profile in _RESERVED_PROFILES or not _PROFILE_RE.match(profile)):
        print(f"profile names are [a-z0-9_-], lowercase, not "
              f"{sorted(_RESERVED_PROFILES)} — got {profile!r}", file=sys.stderr)
        return 2
    store = load()
    profiles = store.get(name, {})
    # undotted edits the default profile; the trailing name prompt is a save-as
    current = profiles.get(profile or "default")
    vals = _prompt_values(name, current=current)
    if vals is None:
        return 2
    if not dot:
        profile = _prompt_profile_name(suggestion="default")
        if profile is None:
            return 2
    store.setdefault(name, {})[profile] = vals
    path = save(store)
    print(f"saved credential set '{name}.{profile}' -> {path}")
    return 0


def _cmd_set(argv: list[str]) -> int:
    # values are ONLY ever prompted (or piped line-per-prompt on stdin): a KEY=VALUE
    # argv form would put secrets in `ps` output and shell history, so it doesn't exist
    if len(argv) != 1:
        print("usage: adb-runner credentials set <name>[.<profile>]\n"
              "values are prompted (secrets hidden), never taken on the command line —\n"
              "argv is visible in `ps` and shell history. Scripts pipe one line per "
              "prompt on stdin.", file=sys.stderr)
        return 2
    return prompt_set(argv[0])


def _cmd_remove(argv: list[str]) -> int:
    if not argv:
        print("usage: adb-runner credentials remove <name>[.<profile>]", file=sys.stderr)
        return 2
    name, dot, profile = argv[0].partition(".")
    store = load()
    if name not in store or (dot and profile not in store[name]):
        print(f"credential set {argv[0]!r} not configured", file=sys.stderr)
        return 1
    if dot:
        del store[name][profile]
        if not store[name]:
            del store[name]
    else:
        del store[name]
    save(store)
    print(f"removed credential set {argv[0]!r}")
    return 0


def credentials_cli(argv: list[str]) -> int:
    """`adb-runner credentials <list|set|remove|path>` — manage the local credential store."""
    if not argv or argv[0] in ("-h", "--help"):
        print(
            "adb-runner credentials — local model credentials & endpoints\n\n"
            "  list                      show configured credential sets\n"
            "  set <name>[.<profile>]    add/update a credential set — every value is\n"
            "                            prompted (secrets hidden; never on the\n"
            "                            command line)\n"
            "  remove <name>[.<profile>] delete a credential set or one profile\n"
            "  path                      print the store file path\n"
        )
        return 0 if argv else 2
    cmd, rest = argv[0], argv[1:]
    try:
        if cmd == "list":
            return _cmd_list()
        if cmd == "set":
            return _cmd_set(rest)
        if cmd == "remove":
            return _cmd_remove(rest)
    except ValueError as exc:  # e.g. a group/other-readable store file
        print(str(exc), file=sys.stderr)
        return 2
    if cmd == "path":
        print(config_path())
        return 0
    print(f"unknown credentials command {cmd!r}", file=sys.stderr)
    return 2
