"""adb-runner CLI.

Invoked via the mkExperiment wrapper, which bakes ADB_MANIFEST, ADB_EXPERIMENT_BIN,
ADB_SOURCE (per-experiment content identity) and ADB_FETCH_REF (fetchable repo rev)
into the environment. One invocation resolves one condition and executes its
replicates locally; there is no server in the execution path.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import sys
from pathlib import Path

from . import credentials
from .canonical import abbrev, condition_id
from .protocol import execute_run
from .schema import (
    MissingParamsError,
    SchemaError,
    bind_params,
    load_manifest,
    validate_realized,
    validate_spec,
)
from .shorthand import ShorthandError, parse_value
from .store import RunStore, default_home, ensure_condition
from .ulid import ulid


# the local viewer (adb-web). One constant so the startup hint and the per-run links
# can't drift apart; run links use the bare-id route the web app resolves itself.
VIEWER_URL = "http://127.0.0.1:8340"


def _log(msg: str) -> None:
    print(f"adb: {msg}", file=sys.stderr)


def _parse_kv(raw: str, flag: str) -> tuple[str, str]:
    key, sep, value = raw.partition("=")
    if not sep or not key.strip():
        raise SystemExit(f"adb: {flag} expects KEY=VALUE, got {raw!r}")
    return key.strip(), value


def _derive_seed(base_seed: int, cid: str, replicate: int) -> int:
    digest = hashlib.sha256(f"{base_seed}:{cid}:{replicate}".encode()).digest()
    return int.from_bytes(digest[:8], "big")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="adb-runner", add_help=True)
    p.add_argument("--set", action="append", default=[], metavar="KEY=VALUE",
                   help="set a param (JSON, @file, or bare string); repeatable")
    p.add_argument("--replicates", type=int, default=1, metavar="N",
                   help="runs to draw from this condition (default 1)")
    p.add_argument("--seed", type=int, default=None, help="base seed (random if omitted)")
    p.add_argument("--out", default=None, metavar="DIR", help="override $ADB_HOME")
    p.add_argument("--json", action="store_true", help="stream events to stdout (headless)")
    p.add_argument("--dry-run", action="store_true",
                   help="print the resolved condition + hash, execute nothing")
    p.add_argument("--describe", action="store_true",
                   help="print the experiment schema JSON and exit")
    return p


def suggested_oneliner(manifest: dict) -> str:
    """The fully-explicit invocation, every param bound to a real declared value:
    its `initial`, else its first suggestion, else an enum's first member — so the
    printed command runs as-is. This is what the composer would hand you; printing
    it keeps the CLI usable without the GUI while every param stays on the command
    line — the oneliner IS the condition spec, nothing hidden in defaults. Only a
    param the manifest names no value for anywhere gets a `<name>` placeholder."""
    import shlex

    sets = []
    # presentation order: params may carry an `order` hint (task-level params first —
    # they're what a researcher cares about); ties break by name
    ordered = sorted(manifest["params"].items(), key=lambda kv: (kv[1].get("order", 100), kv[0]))
    for name, pschema in ordered:
        suggestions = pschema.get("suggestions") or []
        tdesc = pschema.get("type") or {}
        if "initial" in pschema:
            value = pschema["initial"]
        elif suggestions:
            first = suggestions[0]
            value = first.get("value") if isinstance(first, dict) else first
        elif tdesc.get("kind") == "enum" and tdesc.get("values"):
            value = tdesc["values"][0]
        else:
            sets.append(f"--set {shlex.quote(f'{name}=<{name}>')}")
            continue
        rendered = value if isinstance(value, str) else json.dumps(
            value, separators=(",", ":"))
        sets.append(f"--set {shlex.quote(f'{name}={rendered}')}")
    return f"nix run .#{manifest['name']} -- " + " ".join(sets)


def resolve_condition(args, manifest: dict, source: str) -> dict:
    """Returns {params, cid} — the one condition this invocation runs."""
    overrides: dict = {}
    for entry in args.set:
        key, value = _parse_kv(entry, "--set")
        overrides[key] = parse_value(value)
    params = bind_params(manifest, overrides)
    validate_spec(params, manifest)
    cid = condition_id(manifest["name"], source, params)
    return {"params": params, "cid": cid}


def main() -> int:
    # `adb-runner credentials …` manages the local credential store; it is a standalone
    # management command, not a run, so it needs no manifest/experiment env.
    if sys.argv[1:2] == ["credentials"]:
        from .credentials import credentials_cli
        return credentials_cli(sys.argv[2:])

    args = build_parser().parse_args()

    manifest_path = os.environ.get("ADB_MANIFEST")
    program = os.environ.get("ADB_EXPERIMENT_BIN")
    if not manifest_path or not program:
        _log("ADB_MANIFEST / ADB_EXPERIMENT_BIN not set — run via the experiment app "
             "(nix run adb#<experiment>)")
        return 2
    manifest = load_manifest(manifest_path)
    # Identity vs reproducibility: ADB_SOURCE is this experiment's content id — it
    # alone feeds the condition hash, so editing one experiment subtree never shifts
    # another's. ADB_FETCH_REF is the fetchable repo rev, recorded for reproducibility.
    source = os.environ.get("ADB_SOURCE") or "dirty:unknown"
    fetch_ref = os.environ.get("ADB_FETCH_REF") or "dirty:unknown"

    if args.describe:
        print(json.dumps(manifest, indent=2, sort_keys=True))
        return 0

    try:
        cond = resolve_condition(args, manifest, source)
    except MissingParamsError as exc:
        _log(f"error: {exc}")
        _log(f"bind every param on the command line — e.g.: {suggested_oneliner(manifest)}")
        return 2
    except (SchemaError, ShorthandError, OSError) as exc:
        _log(f"error: {exc}")
        return 2

    base_seed = args.seed if args.seed is not None else random.SystemRandom().getrandbits(32)
    replicates = args.replicates

    if args.dry_run:
        print(f"experiment: {manifest['name']}\nsource:     {source}\nbase seed:  {base_seed}")
        print(f"1 condition x {replicates} replicate(s) = {replicates} run(s)\n")
        print(f"condition {abbrev(cond['cid'])}  ({cond['cid']})")
        print(json.dumps(cond["params"], indent=2, sort_keys=True))
        return 0

    home = default_home() if args.out is None else Path(args.out)
    home.mkdir(parents=True, exist_ok=True)
    _log(f"{manifest['name']}: {replicates} replicate(s) of condition "
         f"{abbrev(cond['cid'])}, base seed {base_seed}")
    _log(f"watch runs live at {VIEWER_URL} — start the viewer with: nix run .#adb-web")

    json_out = (lambda e: print(json.dumps(e, separators=(",", ":")), flush=True)) if args.json else None

    # Credentials resolve ONCE per invocation (they are constant across replicates —
    # a picker that re-asked every replicate would be noise). Interactively this may
    # prompt: first-use setup for an unconfigured built-in (the run continues with
    # the freshly entered credential; secrets never touch argv), and the profile
    # picker when named profiles exist. Headless (piped stdin or --json) it never
    # prompts — remembered choice, else default profile, else exit 2 with the fix.
    realized = cond["params"]  # no distributions in the MVP: realized ARE the spec params
    interactive = sys.stdin.isatty() and not args.json
    try:
        credential_env = credentials.resolve_run_credentials(
            manifest, realized, experiment=manifest["name"], interactive=interactive)
    except ValueError as exc:
        _log(f"provisioning failed: {exc}")
        return 2

    counts = {"completed": 0, "failed": 0, "interrupted": 0}
    try:
        ensure_condition(home, cond["cid"], {
            "experiment": manifest["name"], "source": source, "params": cond["params"],
        })
        for replicate in range(1, replicates + 1):
            run_seed = _derive_seed(base_seed, cond["cid"], replicate)
            try:
                validate_realized(realized, manifest)
            except SchemaError as exc:
                _log(f"[{abbrev(cond['cid'])} r{replicate}] provisioning failed: {exc}")
                counts["failed"] += 1
                continue
            run_id = ulid()
            store = RunStore(home, cond["cid"], run_id)
            label = f"[{abbrev(cond['cid'])} r{replicate}]"
            _log(f"{label} {run_id} writing to {store.dir}")

            def on_event(envelope, _label=label):
                # an experiment's error-level log is the "why it failed" — say it on
                # the terminal as it happens, not only in the stored stream
                ev = envelope.get("event") or {}
                if ev.get("type") == "log" and ev.get("level") == "error":
                    _log(f"{_label} error: {ev.get('message')}")
                if json_out:
                    json_out(envelope)

            result = execute_run(
                program=program,
                manifest=manifest,
                spec_params=cond["params"],
                realized_params=realized,
                condition_id=cond["cid"],
                source=source,
                fetch_ref=fetch_ref,
                seed=run_seed,
                replicate=replicate,
                store=store,
                run_id=run_id,
                on_event=on_event,
                credential_env=credential_env,
            )
            counts[result.phase] = counts.get(result.phase, 0) + 1
            summary = " ".join(f"{k}={v}" for k, v in result.summary.items())
            _log(f"{label} {result.run_id} {result.phase} "
                 f"{summary} ({result.duration_s:.1f}s, "
                 f"{result.usage['llm_calls']} calls, "
                 f"{result.usage['input_tokens']}+{result.usage['output_tokens']} tok) "
                 f"— {VIEWER_URL}/#/runs/{result.run_id}")
    except KeyboardInterrupt:
        _log("interrupted — partial runs kept (garbage is data)")
        counts["interrupted"] += 1

    _log(f"done: {counts['completed']} completed, {counts['failed']} failed, "
         f"{counts['interrupted']} interrupted")
    return 0


if __name__ == "__main__":
    sys.exit(main())
