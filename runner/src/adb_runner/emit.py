"""adb-emit: the event vocabulary made executable (docs/plan/events.md).

    adb-emit message --from agent-2 --channel town --content "hi" --meta '{"day": 2}'
    adb-emit metric --name winner --value village
    adb-emit llm-call --agent a --model mock/x < call.json
    adb-emit schema [TYPE]

Validates against the same models the runner lints with (events_schema.py) and prints
one conformant payload line to stdout — which IS the event channel (the runner wraps
each line in the transport envelope), so a shell adapter just calls it inline. Wrong shape = loud error on stderr, exit 2. This is the
no-library help story: language-neutral emission with the schema enforced at the point
of use; python experiments may instead vendor a small emitter (werewolf's events.py is
the reference) and validate in their tests via `adb-emit schema`.
"""

from __future__ import annotations

import argparse
import json
import sys

import msgspec

from .events_schema import EVENT_MODELS, json_schemas

# CLI surface per type: (flag-name, field-name, kind) where kind ∈
# str | json (value parsed as JSON) | jsonish (JSON if it parses, else raw string)
# | strlist (comma-separated). Required-ness is the model's job, not argparse's.
FIELDS: dict[str, list[tuple[str, str, str]]] = {
    "status": [("--detail", "detail", "str")],
    "log": [("--message", "message", "str"), ("--level", "level", "str")],
    "metric": [("--name", "name", "str"), ("--value", "value", "jsonish"),
               ("--step", "step", "json"), ("--unit", "unit", "str")],
    "message": [("--from", "from", "str"), ("--content", "content", "str"),
                ("--channel", "channel", "str"), ("--to", "to", "str"),
                ("--visible-to", "visible_to", "strlist"), ("--meta", "meta", "json")],
    "llm-call": [("--agent", "agent", "str"), ("--model", "model", "str"),
                 ("--latency-ms", "latency_ms", "json"),
                 ("--request", "request", "json"), ("--response", "response", "json"),
                 ("--usage", "usage", "json"), ("--error", "error", "json")],
    "agent-event": [("--agent", "agent", "str"), ("--kind", "kind", "str"),
                    ("--data", "data", "json")],
    "artifact": [("--name", "name", "str"), ("--path", "path", "str"),
                 ("--media-type", "media_type", "str"), ("--bytes", "bytes", "json")],
}

# subcommand name → wire type name
WIRE_TYPE = {name: name for name in FIELDS}
WIRE_TYPE.update({"llm-call": "llm.call", "agent-event": "agent.event"})


def _parse(kind: str, raw: str, flag: str):
    if kind == "str":
        return raw
    if kind == "strlist":
        return [s.strip() for s in raw.split(",") if s.strip()]
    if kind == "jsonish":
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return raw
    try:  # kind == "json"
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"adb-emit: {flag} expects JSON, got {raw!r} ({exc})")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="adb-emit", description=__doc__)
    subs = parser.add_subparsers(dest="command", required=True)
    for name, fields in FIELDS.items():
        sub = subs.add_parser(name, help=f"emit a {WIRE_TYPE[name]} event")
        for flag, _field, _kind in fields:
            sub.add_argument(flag, dest=flag.lstrip("-").replace("-", "_"), default=None)
    schema = subs.add_parser("schema", help="print JSON Schema for one or all event types")
    schema.add_argument("type", nargs="?", choices=sorted(EVENT_MODELS))
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    if args.command == "schema":
        schemas = json_schemas()
        if args.type:
            print(json.dumps(schemas[args.type], indent=2))
        else:
            print(json.dumps({t: schemas[t] for t in sorted(schemas)}, indent=2))
        return 0

    wire_type = WIRE_TYPE[args.command]
    body: dict = {}
    for flag, field, kind in FIELDS[args.command]:
        raw = getattr(args, flag.lstrip("-").replace("-", "_"))
        if raw is not None:
            body[field] = _parse(kind, raw, flag)

    # llm-call: the bulky parts (request/response/usage/error) may arrive as one JSON
    # object on stdin instead of flags — flags win field-by-field if both are given.
    if args.command == "llm-call" and not sys.stdin.isatty():
        stdin_raw = sys.stdin.read().strip()
        if stdin_raw:
            stdin_body = _parse("json", stdin_raw, "stdin")
            if not isinstance(stdin_body, dict):
                raise SystemExit("adb-emit: llm-call stdin must be a JSON object")
            body = {**stdin_body, **body}

    try:
        model = msgspec.convert(body, EVENT_MODELS[wire_type])
    except msgspec.ValidationError as exc:
        print(f"adb-emit: invalid {wire_type} event: {exc}", file=sys.stderr)
        return 2

    # encode→decode applies the struct's field renames (from_→from) and omit_defaults
    event = {"type": wire_type, **msgspec.json.decode(msgspec.json.encode(model))}
    print(json.dumps(event, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
