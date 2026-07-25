#!/usr/bin/env python3
"""Regenerate model_catalog.json — the provider model catalog (`types.llm` hints).

This is PROVIDER knowledge, deliberately not wrapper knowledge: which models
each provider serves, under which exact ids. It lives beside the runner's
provider registry conceptually — any wrapper (inspect today, others later)
builds its own suggestion syntax over it; only suggestions.nix's value
formatting follows inspect's provider-prefix convention.

One command, no hand edits:  task models:update  (or run this file directly).

Two public catalogs are joined:
  - models.dev/api.json ........ the curated current lineup per provider, with
                                 per-model metadata (name, release_date, modalities)
  - LiteLLM's model_prices json  the largest public index of *dated snapshot* ids
                                 (gpt-4o-2024-11-20, claude-sonnet-4-5-20250929, ...)

models.dev decides WHICH models exist; LiteLLM upgrades each id to its newest
dated snapshot when one exists (policy: hints are fully-qualified wherever the
provider mints dated ids, so a condition pins the snapshot, not a moving alias).
The public catalogs lag on snapshots for the newest models, so two first-party
sources fill the gap: (1) the provider SDKs' own model-id literal types,
fetched anonymously from their public source — the provider's authored list of
every accepted id, which both supplies dated ids the catalogs missed and
proves when a new model's canonical id is genuinely undated (Anthropic's
newest are); (2) the provider's authenticated /models endpoint, when a key is
available in the environment or the adb runner's credential store
(`adb-runner providers` / ~/.config/adb/providers.toml). Keyless runs are
first-class: SDK literals cover the id-form question without credentials.
Providers listed here are exactly the API-backed providers whose SDKs adb-inspect
installs (an explicit map, deliberately not discovered); pattern-style providers
(azureai deployments, openai-api/openrouter passthrough) are static hints in
suggestions.nix instead, since they have no enumerable model list.

Output is deterministic for unchanged upstream data (no timestamps): a clean
`git diff` after running IS the update.
"""

from __future__ import annotations

import json
import os
import re
import sys
import urllib.request
from pathlib import Path

MODELS_DEV_URL = "https://models.dev/api.json"
LITELLM_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json"

# inspect provider prefix -> (models.dev provider key, litellm_provider key,
# litellm id prefix to strip, credential hint shown in the GUI)
PROVIDERS = {
    "anthropic": ("anthropic", "anthropic", "", "Needs ANTHROPIC_API_KEY (asked for on first run)."),
    "openai": ("openai", "openai", "", "Needs OPENAI_API_KEY (asked for on first run)."),
    "google": ("google", "gemini", "gemini/", "Needs GOOGLE_API_KEY (asked for on first run)."),
    "groq": ("groq", "groq", "groq/", "Needs GROQ_API_KEY (asked for on first run)."),
    "mistral": ("mistral", "mistral", "mistral/", "Needs MISTRAL_API_KEY (asked for on first run)."),
    "grok": ("xai", "xai", "xai/", "Needs GROK_API_KEY (asked for on first run)."),
    "bedrock": ("amazon-bedrock", None, "", "Uses your AWS credentials (AWS_ACCESS_KEY_ID / profile) and region."),
}

# live /models endpoints, queried only when the key env var is set: the public
# catalogs lag on dated snapshot ids for the newest models, the providers don't.
# (env var, url, auth style); google's REST list takes the key as a query param.
PROVIDER_APIS = {
    "anthropic": ("ANTHROPIC_API_KEY", "https://api.anthropic.com/v1/models?limit=1000", "anthropic"),
    "openai": ("OPENAI_API_KEY", "https://api.openai.com/v1/models", "bearer"),
    "google": ("GOOGLE_API_KEY", "https://generativelanguage.googleapis.com/v1beta/models", "google"),
    "groq": ("GROQ_API_KEY", "https://api.groq.com/openai/v1/models", "bearer"),
    "mistral": ("MISTRAL_API_KEY", "https://api.mistral.ai/v1/models", "bearer"),
    "grok": ("XAI_API_KEY", "https://api.x.ai/v1/models", "bearer"),
}

# First-party, public, keyless id lists — each provider's own declaration of the
# ids its API accepts, as (url, extraction regex) pairs. SDK literal-type modules
# where the SDK ships them (anthropic, openai); the provider's official docs in
# their machine-readable form otherwise (llms.txt-style markdown, or the docs HTML
# for google, whose devsite serves no markdown). These are authoritative in a way
# community catalogs are not: LiteLLM has shipped dated ids providers 404 on.
FIRST_PARTY_ID_SOURCES = {
    "anthropic": [(
        "https://raw.githubusercontent.com/anthropics/anthropic-sdk-python/main/src/anthropic/types/model.py",
        r'"([a-z0-9][a-z0-9._/-]*)"',
    )],
    "openai": [(
        "https://raw.githubusercontent.com/openai/openai-python/main/src/openai/types/shared/chat_model.py",
        r'"([a-z0-9][a-z0-9._/-]*)"',
    )],
    "google": [(
        "https://ai.google.dev/gemini-api/docs/models",
        r"\b(gemini-[0-9][a-zA-Z0-9.-]+|gemma-[0-9a-z.-]+)\b",
    )],
    "groq": [(
        "https://console.groq.com/docs/models.md",
        r"/docs/model/([a-z0-9._/-]+)\)|\b(groq/compound(?:-mini)?)\b",
    )],
    "mistral": [(
        "https://docs.mistral.ai/llms-full.txt",
        r"`([a-z][a-z0-9.-]*(?:-latest|-2[0-9]{3}))`",
    )],
    "grok": [(
        "https://docs.x.ai/docs/models.md",
        r"\b(grok-[a-z0-9.-]+)\b",
    )],
}

DATE_SUFFIX = re.compile(r"^(?P<stem>.+?)[-@](?P<date>20\d{2}-?\d{2}-?\d{2})$")
# mistral versions snapshots as -YYMM (mistral-small-2603); "-latest" is its moving alias
MISTRAL_SUFFIX = re.compile(r"^(?P<stem>.+?)-(?P<date>2\d{3})$")
BEDROCK_REGION = re.compile(r"^(?:us|eu|apac|jp|au|ca|global)\.")


def fetch(url: str, headers: dict | None = None) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": "adb-model-catalog-updater", **(headers or {})})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def stored_credentials() -> dict[str, str]:
    """Env-var -> value from the adb runner's credential store (never printed).

    Mirrors adb_runner.providers.config_path(): $ADB_PROVIDERS_FILE overrides,
    else $XDG_CONFIG_HOME/adb/providers.toml, else ~/.config/adb/providers.toml.
    """
    import tomllib

    override = os.environ.get("ADB_PROVIDERS_FILE")
    if override:
        path = Path(override)
    else:
        base = os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config")
        path = Path(base) / "adb" / "providers.toml"
    if not path.is_file():
        return {}
    data = tomllib.loads(path.read_text())
    return {
        k: str(v)
        for vals in data.values()
        if isinstance(vals, dict)
        for k, v in vals.items()
    }


def first_party_doc_ids(prefix: str) -> list[str]:
    """Model ids from the provider's own public declarations, [] on failure."""
    ids: list[str] = []
    for url, pattern in FIRST_PARTY_ID_SOURCES.get(prefix, []):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "adb-model-catalog-updater"})
            with urllib.request.urlopen(req, timeout=60) as r:
                source = r.read().decode(errors="replace")
        except OSError:
            continue
        for match in re.findall(pattern, source):
            groups = [match] if isinstance(match, str) else list(match)
            ids.extend(g for g in groups if g)
    return sorted(set(ids))


def live_provider_ids(prefix: str, stored: dict[str, str]) -> list[str]:
    """The provider's own current model ids, [] when no key is configured."""
    if prefix not in PROVIDER_APIS:
        return []
    env, url, auth = PROVIDER_APIS[prefix]
    key = os.environ.get(env, "") or stored.get(env, "")
    if not key:
        return []
    if auth == "anthropic":
        data = fetch(url, {"x-api-key": key, "anthropic-version": "2023-06-01"})
    elif auth == "google":
        data = fetch(f"{url}?key={key}")
        return [m["name"].removeprefix("models/") for m in data.get("models", [])]
    else:
        data = fetch(url, {"Authorization": f"Bearer {key}"})
    return [m["id"] for m in data.get("data", [])]


def text_chat_model(m: dict) -> bool:
    mod = m.get("modalities") or {}
    inputs, outputs = mod.get("input") or [], mod.get("output") or []
    return "text" in inputs and set(outputs) == {"text"}


def dated_snapshots(litellm: dict) -> dict[tuple[str, str], list[tuple[str, str]]]:
    """(litellm_provider, undated stem) -> [(date, dated id), ...]"""
    out: dict[tuple[str, str], list[tuple[str, str]]] = {}
    for key, meta in litellm.items():
        if meta.get("mode") not in ("chat", "responses"):
            continue
        provider = meta.get("litellm_provider")
        m = DATE_SUFFIX.match(key.rsplit("/", 1)[-1])
        if provider and m:
            out.setdefault((provider, m["stem"]), []).append((m["date"].replace("-", ""), key.rsplit("/", 1)[-1]))
    return out


def stem_of(prefix: str, model_id: str) -> str:
    """The id with any snapshot qualifier or moving-alias suffix removed."""
    if m := DATE_SUFFIX.match(model_id):
        return m["stem"]
    if prefix == "mistral":
        if model_id.endswith("-latest"):
            return model_id.removesuffix("-latest")
        if m := MISTRAL_SUFFIX.match(model_id):
            return m["stem"]
    if model_id.endswith("-latest"):
        return model_id.removesuffix("-latest")
    return model_id


def qualified_id(prefix: str, mdev_id: str, snapshots: dict[str, list[tuple[str, str]]]) -> str:
    """Newest dated snapshot for this model, or the id as-is when none is known."""
    if DATE_SUFFIX.match(mdev_id):
        return mdev_id
    candidates = snapshots.get(stem_of(prefix, mdev_id), [])
    return max(candidates)[1] if candidates else mdev_id


def main() -> int:
    models_dev, litellm = fetch(MODELS_DEV_URL), fetch(LITELLM_URL)
    ll_snapshots = dated_snapshots(litellm)
    stored = stored_credentials()

    providers = {}
    keyless = []
    for prefix, (mdev_key, ll_key, _strip, cred) in PROVIDERS.items():
        # First-party id lists: SDK literals (keyless) + the live /models endpoint
        # (when a key is available). When ANY first-party list exists it is the
        # EXCLUSIVE snapshot source — community catalogs have shipped dated ids the
        # provider's API 404s on (claude-opus-4-6-20260205), so litellm only fills
        # in for providers with no first-party list at all.
        doc_ids = first_party_doc_ids(prefix)
        live = live_provider_ids(prefix, stored)
        first_party = doc_ids + live
        snapshots: dict[str, list[tuple[str, str]]] = {}
        if first_party:
            for fp_id in first_party:
                if m := DATE_SUFFIX.match(fp_id):
                    snapshots.setdefault(m["stem"], []).append((m["date"].replace("-", ""), fp_id))
        else:
            for (ll_provider, stem), dated in ll_snapshots.items():
                if ll_provider == ll_key:
                    snapshots.setdefault(stem, []).extend(dated)
        if doc_ids:
            print(f"{prefix}: first-party id list used ({len(doc_ids)} ids)")
        if live:
            print(f"{prefix}: live /models list used ({len(live)} ids)")
        elif prefix in PROVIDER_APIS and not doc_ids:
            keyless.append(prefix)

        lineup = [m for m in models_dev[mdev_key]["models"].values() if text_chat_model(m)]
        models = [
            {
                "id": qualified_id(prefix, m["id"], snapshots),
                "name": m.get("name", m["id"]),
                "release_date": m.get("release_date", ""),
            }
            for m in lineup
        ]
        # a dated id, its undated alias, and any -latest alias are the same model:
        # keep one entry, preferring the qualified id (sorted last within a stem)
        by_stem = {}
        for m in sorted(
            models,
            key=lambda m: (m["release_date"], 0 if m["id"].endswith("-latest") else 1, m["id"]),
        ):
            by_stem[stem_of(prefix, m["id"])] = m
        # ... then expand each model to EVERY dated snapshot the provider serves
        # (gpt-4o has three; each is a distinct pinned artifact and a legitimate
        # condition) — the model's entry above already carries the newest
        for stem, m in list(by_stem.items()):
            for date, snap_id in sorted(set(snapshots.get(stem, [])), reverse=True):
                if snap_id != m["id"]:
                    by_stem[snap_id] = {
                        "id": snap_id,
                        "name": m["name"],
                        "release_date": f"{date[:4]}-{date[4:6]}-{date[6:]}",
                    }
        # every model is surfaced (the GUI combobox is type-to-filter; curation is
        # the user's job, not the catalog's), sorted newest first
        models = sorted(by_stem.values(), key=lambda m: (m["release_date"], m["id"]), reverse=True)
        # visibility tripwire: an id the provider's own list doesn't contain is
        # either lag in models.dev or a bogus community id — say so
        fp_set = set(first_party)
        for m in models:
            if fp_set and m["id"] not in fp_set:
                print(f"note: {prefix}/{m['id']} absent from the first-party id list")
        providers[prefix] = {"credential_hint": cred, "models": models}

    out = {
        "_generated_by": "lib/model-catalog/update.py — do not edit by hand",
        "sources": [MODELS_DEV_URL, LITELLM_URL],
        "providers": providers,
    }
    path = Path(__file__).resolve().parent / "model_catalog.json"
    path.write_text(json.dumps(out, indent=1) + "\n")
    total = sum(len(p["models"]) for p in providers.values())
    print(f"wrote {path.relative_to(Path.cwd()) if path.is_relative_to(Path.cwd()) else path}: "
          f"{total} models across {len(providers)} providers")
    if keyless:
        print(
            f"WARNING: no first-party id source for {', '.join(keyless)} (no SDK literal "
            f"list, no credentials) — their newest ids may be undated aliases. Configure "
            f"keys (`nix run .#adb-runner -- providers set ...`) and rerun to check them "
            f"against the providers' own /models endpoints."
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
