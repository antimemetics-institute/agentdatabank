"""Read-only audit of saved evidence and its rebuildable index card."""

import argparse
from collections.abc import Mapping
from dataclasses import dataclass
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from typing import Any
from urllib.parse import urlsplit

from adb_events import Envelope, Json, read_events
from adb_providers import PROVIDERS

from . import credentials
from .card import derive_card
from .schema import Manifest, load_manifest
from .secrets import assert_run_has_no_secrets


class VerificationError(ValueError):
    """An audit finding, safe to print without exposing record or credential values."""


@dataclass(frozen=True)
class Verification:
    records: int
    credential_values: int


# Invoke only the current build's interpreter and declared union, never code paths
# supplied by run.json or event payloads. Capture diagnostics: Pydantic's normal
# error output includes input values and must not echo a leaked credential.
_VALIDATE_UNION = '''
import importlib, sys
from adb_events import read_events
try:
    module, attr = sys.argv[1].split(":")
    payload = getattr(importlib.import_module(module), attr)
except Exception:
    print("cannot import experiment payload union")
    raise SystemExit(1)
count = 0
try:
    for record in read_events(sys.argv[2], payload=payload):
        count += 1
except Exception:
    print(f"experiment payload validation failed at events.jsonl:{count + 1}")
    raise SystemExit(1)
'''


def credential_snapshot(endpoints: Mapping[str, str], environment: Mapping[str, str] | None = None) -> dict[str, str]:
    """Check all profiles for recorded endpoints, plus ambient credentials.

    These shell/UI settings have credential-like names but are not secrets and
    are not forwarded to experiments. In particular KEYTIMEOUT is a small integer.
    """
    public_settings = {"KEYTIMEOUT", "LESSKEYIN_SYSTEM", "KITTY_PUBLIC_KEY"}
    values = {key: value for key, value in (os.environ if environment is None else environment).items()
              if key not in public_settings and re.search(r"KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL", key, re.I)}
    for provider, profiles in credentials.load().items():
        if provider not in endpoints:
            continue
        template = PROVIDERS.get(provider)
        for profile, fields in profiles.items():
            base_url = fields.get(template.base_url.name if template else f"{provider.upper()}_BASE_URL")
            base_url = base_url or (template.base_url.default if template else "")
            recorded, configured = urlsplit(endpoints[provider]), urlsplit(base_url)
            if (recorded.scheme, recorded.hostname, recorded.port) != (configured.scheme, configured.hostname, configured.port):
                continue
            for name, value in fields.items():
                if re.search(r"KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL", name, re.I):
                    values[f"{provider}.{profile}.{name}"] = value
    return values


def _manifest_path(experiment: str, *, manifest: Path | None, catalog: Path | None) -> Path:
    if manifest is not None:
        return manifest
    if os.environ.get("ADB_MANIFEST"):
        return Path(os.environ["ADB_MANIFEST"])
    if catalog is None and os.environ.get("ADB_MANIFESTS"):
        catalog = Path(os.environ["ADB_MANIFESTS"])
    if catalog is None:
        if not Path("default.nix").is_file():
            raise VerificationError("run verify from an ADB checkout, through the experiment app, or pass --manifest/--catalog")
        built = subprocess.run(["nix-build", "--no-out-link", "-A", "manifests"],
                               text=True, capture_output=True)
        if built.returncode:
            raise VerificationError("could not build the manifest catalog; pass --manifest/--catalog from a successful build")
        catalog = Path(built.stdout.strip())
    # Names come from records; they are never treated as paths or Nix expressions.
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]*", experiment):
        raise VerificationError("invalid experiment identifier")
    return catalog / f"{experiment}.json"


def _records(run_dir: Path) -> list[Envelope[Any]]:
    records: list[Envelope[Any]] = []
    try:
        for record in read_events(run_dir):
            records.append(record)
    except (OSError, ValueError):
        raise VerificationError(f"envelope validation failed at events.jsonl:{len(records) + 1}") from None
    if not records or records[0].event.type != "run.start" or records[-1].event.type != "run.end":
        raise VerificationError("run must start with run.start and finish with run.end")
    first = records[0]
    for seq, record in enumerate(records):
        if record.seq != seq:
            raise VerificationError(f"non-contiguous sequence at events.jsonl:{seq + 1}")
        if (record.run, record.experiment, record.schema_) != (first.run, first.experiment, first.schema_):
            raise VerificationError(f"envelope identity differs at events.jsonl:{seq + 1}")
        if 0 < seq < len(records) - 1 and record.event.type in {"run.start", "run.end"}:
            raise VerificationError(f"unexpected lifecycle record at events.jsonl:{seq + 1}")
    return records


def _validate_union(run_dir: Path, manifest: Manifest, records: list[Envelope[Any]]) -> None:
    schema = manifest.get("schema")
    if not schema or manifest["name"] != records[0].experiment or schema["version"] != records[0].schema_:
        raise VerificationError("manifest experiment/schema does not match the stream")
    interpreter = (Path(schema["path"]).parent / "python") if "path" in schema else Path(sys.executable)
    if not interpreter.is_file():
        raise VerificationError("schema interpreter is unavailable; rebuild the experiment manifest")
    result = subprocess.run([str(interpreter), "-c", _VALIDATE_UNION, schema["models"], str(run_dir.resolve())],
                            text=True, capture_output=True)
    if result.returncode:
        message = result.stdout.strip()
        if not re.fullmatch(r"cannot import experiment payload union|experiment payload validation failed at events.jsonl:\d+", message):
            message = "experiment payload validation failed"
        raise VerificationError(message)


def verify_run(run_dir: Path, *, manifest: Path | None = None, catalog: Path | None = None,
               environment: Mapping[str, str] | None = None) -> Verification:
    """Audit all saved files, typed records, identity/order, and every card section.

    Terminal failed/interrupted runs can also be audited; this checks evidence
    integrity, not scientific outcomes or successful model responses. Never repairs
    records or the card. Checks all local profiles matching the recorded endpoints.
    """
    records = _records(run_dir)
    values = credential_snapshot(records[0].event.runtime.endpoints, environment)
    try:
        assert_run_has_no_secrets(run_dir, environment=values)
    except AssertionError as exc:
        raise VerificationError(f"secrets scan: {exc}") from None
    path = _manifest_path(records[0].experiment, manifest=manifest, catalog=catalog)
    try:
        declaration = load_manifest(path)
    except (OSError, ValueError, TypeError, KeyError):
        raise VerificationError("cannot load experiment manifest") from None
    _validate_union(run_dir, declaration, records)
    try:
        card: Json = json.loads((run_dir / "run.json").read_text())
    except (OSError, ValueError):
        raise VerificationError("run.json is missing or unreadable") from None
    expected = derive_card(records)
    if not isinstance(card, dict) or set(card) != set(expected):
        raise VerificationError("run.json sections differ from the stream projection")
    for section in expected:
        if json.dumps(card[section], sort_keys=True) != json.dumps(expected[section], sort_keys=True):
            raise VerificationError(f"run.json.{section} differs from the stream projection")
    return Verification(len(records), len({value for value in values.values() if value}))


def verify_cli(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="adb-runner verify", description=__doc__)
    parser.add_argument("run_dir", type=Path, metavar="RUN_DIR")
    parser.add_argument("--manifest", type=Path, help="built experiment manifest (defaults to ADB_MANIFEST)")
    parser.add_argument("--catalog", type=Path, help="built manifest directory (otherwise ADB_MANIFESTS or current checkout)")
    args = parser.parse_args(argv)
    try:
        result = verify_run(args.run_dir, manifest=args.manifest, catalog=args.catalog)
    except VerificationError as exc:
        print(f"verify: FAIL: {exc}", file=sys.stderr)
        return 1
    except Exception:
        # Filesystem, credential-store and import failures must also fail closed,
        # without letting a dependency traceback print inputs or credential values.
        print("verify: FAIL: audit could not complete; check the run, manifest and credential store", file=sys.stderr)
        return 1
    print(f"verify: PASS: {result.records} records; experiment union, secrets scan "
          f"({result.credential_values} known credential values), and card match")
    return 0
