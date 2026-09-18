"""adb-runner CLI.

Invoked via the mkExperiment wrapper, which bakes ADB_MANIFEST, ADB_EXPERIMENT_BIN,
ADB_SOURCE (per-experiment content identity), ADB_FETCH_REF (pinned clean repo rev),
and ADB_TREE_HASH (packaging-tree narHash, when known)
into the environment. One invocation resolves one condition and executes one
run locally; there is no server in the execution path.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import shlex
import sys
import urllib.request
from pathlib import Path

from typing import Any, TypedDict

from adb_events import Json

from . import credentials
from .canonical import abbrev, condition_id
from .protocol import execute_run, validate_fetch_ref
from .schema import (
    Manifest,
    MissingParamsError,
    Params,
    SchemaError,
    bind_params,
    load_manifest,
    validate_realized,
    validate_spec,
)
from .shorthand import ShorthandError, parse_value
from .store import RunStore, resolve_data_dir
from .run_id import new_run_id


# the local viewer (adb-web): it binds VIEWER_PORT, walking up when that's taken, so
# the link a run prints is only right if we look. resolve_viewer() probes the ports it
# would have walked and keeps the one serving THIS run store; the default URL is the
# fallback. Run links use the bare-id route the web app resolves itself.
VIEWER_HOST = "127.0.0.1"
VIEWER_PORT = 8340
VIEWER_PROBE_PORTS = 4
VIEWER_URL = f"http://{VIEWER_HOST}:{VIEWER_PORT}"


def _log(msg: str) -> None:
    print(f"adb: {msg}", file=sys.stderr)


def _sgr(text: str, *codes: str) -> str:
    """ANSI-styled on a terminal, plain text anywhere else (pipes, CI, NO_COLOR)."""
    if not sys.stderr.isatty() or os.environ.get("NO_COLOR") or os.environ.get("TERM") == "dumb":
        return text
    return f"\033[{';'.join(codes)}m{text}\033[0m"


def _viewer_ping(port: int, timeout: float = 0.3) -> dict[str, Json] | None:
    """adb-web's identity endpoint: {"adb": "web", "home": <store it serves>}. Whatever
    else might hold the port answers wrong, or not at all, and is skipped. Proxies are
    bypassed explicitly — an http_proxy in the environment must not swallow a probe of
    the machine's own loopback."""
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(f"http://{VIEWER_HOST}:{port}/api/ping", timeout=timeout) as r:
            body: Json = json.loads(r.read(4096))
    except (OSError, ValueError):
        return None
    return body if isinstance(body, dict) and body.get("adb") == "web" else None


def resolve_viewer(home: Path) -> tuple[str, str | None]:
    """(base_url, hint) — where to watch these runs, plus a one-line fix when clicking
    that link won't work yet. A viewer serving a *different* store would never show
    these runs, so it counts as no viewer; we point at it and say how to re-home it."""
    mismatched: tuple[str, str] | None = None
    for port in range(VIEWER_PORT, VIEWER_PORT + VIEWER_PROBE_PORTS):
        ping = _viewer_ping(port)
        if ping is None:
            continue
        base = f"http://{VIEWER_HOST}:{port}"
        served = str(ping.get("home") or "")
        try:
            same = bool(served) and Path(served).resolve() == home.resolve()
        except OSError:
            same = False
        if same:
            return base, None
        if mismatched is None:
            mismatched = (base, served or "somewhere else")
    if mismatched is not None:
        base, served = mismatched
        return base, (f"the viewer at {base} is serving {served}, not {home} — restart it "
                      f"with: nix run .#adb-web -- --data-dir {shlex.quote(str(home))}")
    return VIEWER_URL, ("no viewer running — start one with: "
                        f"nix run .#adb-web -- --data-dir {shlex.quote(str(home))}")


def _parse_kv(raw: str, flag: str) -> tuple[str, str]:
    key, sep, value = raw.partition("=")
    if not sep or not key.strip():
        raise SystemExit(f"adb: {flag} expects KEY=VALUE, got {raw!r}")
    return key.strip(), value


def _seed(raw: str) -> int:
    value = int(raw)
    if not 0 <= value <= 2**31 - 1:
        raise argparse.ArgumentTypeError("seed must be an integer in 0..2147483647")
    return value


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="adb-runner", add_help=True,
                                epilog="Management commands: credentials …; verify RUN_ID_OR_DIR (audit a finished run).")
    p.add_argument("--set", action="append", default=[], metavar="KEY=VALUE",
                   help="set a param (JSON, @file, or bare string); repeatable")
    # profile NAMES are argv-safe (values never are — they live in the 0600 store);
    # an explicit selection skips the picker and the remember question entirely
    p.add_argument("--credential", action="append", default=[], metavar="SET=NAME",
                   help="use that credential profile for that set (repeatable; "
                        "skips the interactive picker)")
    p.add_argument("--seed", type=_seed, metavar="N",
                   help="run seed in 0..2147483647, recorded unchanged (random if omitted)")
    p.add_argument("--data-dir", metavar="DIR",
                   help="run data directory (default $ADB_DATA_DIR, then $XDG_DATA_HOME/adb or ~/.local/share/adb)")
    p.add_argument("--json", action="store_true", help="print recorded events as JSON lines to stdout")
    p.add_argument("--non-interactive", action="store_true",
                   help="never prompt for input; fail if required credentials cannot be resolved")
    p.add_argument("--dry-run", action="store_true",
                   help="print the resolved condition + hash, execute nothing")
    p.add_argument("--describe", action="store_true",
                   help="print the experiment schema JSON and exit")
    return p


def suggested_oneliner(manifest: Manifest) -> str:
    """The fully-explicit invocation, every param bound to a real declared value:
    its `initial`, else its first suggestion, else an enum's first member — so the
    printed command runs as-is. This is what the composer would hand you; printing
    it keeps the CLI usable without the GUI while every param stays on the command
    line — the oneliner IS the condition spec, nothing hidden in defaults. Only a
    param the manifest names no value for anywhere gets a `<name>` placeholder."""
    sets: list[str] = []
    # presentation order: params may carry an `order` hint (task-level params first —
    # they're what a researcher cares about); ties break by name
    ordered = sorted(manifest["params"].items(),
                     key=lambda kv: (kv[1].get("order", 100), kv[0]))
    for name, pschema in ordered:
        suggestions = pschema.get("suggestions") or []
        enum_values = pschema["type"].get("values")
        value: Json
        if "initial" in pschema:
            value = pschema["initial"]
        elif suggestions:
            first = suggestions[0]
            value = first["value"] if isinstance(first, dict) else first
        elif pschema["type"].get("kind") == "enum" and enum_values:
            value = enum_values[0]
        else:
            sets.append(f"--set {shlex.quote(f'{name}=<{name}>')}")
            continue
        rendered = value if isinstance(value, str) else json.dumps(
            value, separators=(",", ":"))
        sets.append(f"--set {shlex.quote(f'{name}={rendered}')}")
    return f"nix run .#{manifest['name']} -- " + " ".join(sets)


class ResolvedCondition(TypedDict):
    params: Params
    cid: str


def resolve_condition(args: argparse.Namespace, manifest: Manifest,
                      source: str) -> ResolvedCondition:
    """Returns {params, cid} — the one condition this invocation runs."""
    overrides: Params = {}
    for entry in args.set:
        key, value = _parse_kv(entry, "--set")
        overrides[key] = parse_value(value)
    params = bind_params(manifest, overrides)
    validate_spec(params, manifest)
    cid = condition_id(manifest["name"], source, params)
    return {"params": params, "cid": cid}


def main() -> int:
    if sys.argv[1:2] == ["verify"]:
        from .verify import verify_cli
        return verify_cli(sys.argv[2:])

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
    try:
        fetch_ref = validate_fetch_ref(os.environ.get("ADB_FETCH_REF"))
    except ValueError:
        _log("fetch_ref must be a valid reference without userinfo")
        return 2
    tree_hash = os.environ.get("ADB_TREE_HASH") or None

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

    seed = args.seed if args.seed is not None else random.SystemRandom().getrandbits(31)

    if args.dry_run:
        print(f"experiment: {manifest['name']}\nsource:     {source}\nseed:       {seed}\n")
        print(f"condition {abbrev(cond['cid'])}  ({cond['cid']})")
        print(json.dumps(cond["params"], indent=2, sort_keys=True))
        return 0

    home = resolve_data_dir(args.data_dir)
    home.mkdir(parents=True, exist_ok=True)
    _log(f"{manifest['name']}: condition {abbrev(cond['cid'])}, seed {seed}")

    def _json_out(envelope: dict[str, Any]) -> None:
        print(json.dumps(envelope, separators=(",", ":")), flush=True)

    json_out = _json_out if args.json else None

    # Credential resolution may prompt for first-use setup of an unconfigured
    # built-in (secrets never touch argv), and the profile
    # picker when named profiles exist. Headless (non-terminal stdin or --non-interactive) it never
    # prompts — remembered choice, else default profile, else exit 2 with the fix.
    realized = cond["params"]  # no distributions in the MVP: realized ARE the spec params
    interactive = sys.stdin.isatty() and not args.non_interactive
    selections = dict(_parse_kv(entry, "--credential") for entry in args.credential)
    try:
        credential_env = credentials.resolve_run_credentials(
            manifest, realized, experiment=manifest["name"], interactive=interactive,
            selections=selections)
    except ValueError as exc:
        _log(f"provisioning failed: {exc}")
        return 2

    # Where to watch, resolved once the gate is behind us: the credential dialogue is
    # the last thing between "I typed a command" and "it's running", so the link lands
    # here — at the bottom of the scroll, where a click actually follows.
    viewer, viewer_hint = resolve_viewer(home)
    if viewer_hint:
        _log(viewer_hint)

    try:
        try:
            validate_realized(realized, manifest)
        except SchemaError as exc:
            _log(f"provisioning failed: {exc}")
            return 2
        run_id = new_run_id()
        store = RunStore(home, cond["cid"], run_id, experiment=manifest["name"])
        label = f"[{abbrev(cond['cid'])}]"
        # two aligned fields, the clickable one first: the URL is the thing a reader
        # wants at the moment a run starts, and it's underlined/cyan so it reads as a
        # link (terminals cmd-click it; it survives a plain copy either way).
        _log(f"{label} run {run_id} started")
        _log(f"  {_sgr('▸ watch', '2')}  {_sgr(f'{viewer}/#/runs/{run_id}', '1;4;36')}")
        _log(f"  {_sgr('▸ store', '2')}  {_sgr(str(store.dir), '2')}")

        def on_event(envelope: dict[str, Any]) -> None:
            # an experiment's error-level log is the "why it failed" — say it on
            # the terminal as it happens, not only in the stored stream
            ev: dict[str, Any] = envelope.get("event") or {}
            if ev.get("type") == "log" and ev.get("level") == "error":
                _log(f"{label} error: {ev.get('message')}")
            if json_out:
                json_out(envelope)

        result = execute_run(
            program=program,
            manifest=manifest,
            params=realized,
            condition_id=cond["cid"],
            source=source,
            fetch_ref=fetch_ref,
            tree_hash=tree_hash,
            seed=seed,
            store=store,
            run_id=run_id,
            on_event=on_event,
            credential_env=credential_env,
        )
        _log(f"{label} {result.run_id} {result.state} ({result.duration_s:.1f}s) "
             f"— {viewer}/#/runs/{result.run_id}")
    except KeyboardInterrupt:
        _log("interrupted — partial runs kept (garbage is data)")
        return 130
    if result.state == "interrupted":
        return 130
    return 0 if result.state == "completed" else 1


if __name__ == "__main__":
    sys.exit(main())
