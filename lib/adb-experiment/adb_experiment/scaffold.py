"""The runner-protocol scaffold for Python experiments.

The protocol (runner side: adb_runner/protocol.py): realized params arrive as
JSON on stdin, ``ADB_RUN_DIR``/``ADB_SEED`` ride in the env, events leave as
JSON lines on stdout, and failure at any stage is data — the run finishes with
a fallback summary and exit 0; only unreadable params exit nonzero. A config
file named on argv overrides stdin — the hand-run/debug path, and the seam an
adapter uses when it reshapes params first (concordia). Every experiment
repeats that scaffold verbatim, so it lives here:

    def main() -> int:
        return experiment_main(Params, run, prog="my-experiment",
                               fallback_summary={"status": "error"})

Also here: ``protected_stream()`` — run a wrapped tool that prints to stdout
without corrupting the JSONL channel — and ``deposit_artifact()`` — write a file
into the run's ``artifacts/`` and emit the pointer event (layout.md).
"""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import sys
import traceback
from pathlib import Path
from typing import Any

from adb_events.emit import artifact, metric, set_output


def experiment_main(params_model, run, *, prog: str,
                    description: str | None = None,
                    fallback_summary: dict[str, Any] | None = None,
                    argv: list[str] | None = None) -> int:
    """The whole main(): read params (stdin, or a config file named on argv),
    validate them (any object with a pydantic-style ``model_validate``), default
    ``ADB_RUN_DIR``, call ``run(params)``. A `run` that raises is data — the
    traceback goes to stderr, each entry of `fallback_summary` is emitted as a
    metric, and the exit code stays 0."""
    parser = argparse.ArgumentParser(prog=prog, description=description)
    parser.add_argument(
        "config", nargs="?",
        help="path to a JSON (or YAML) config file; omitted = params JSON on stdin (the runner protocol)",
    )
    args = parser.parse_args(argv)
    try:
        raw = (json.load(sys.stdin) if args.config is None
               else json.loads(Path(args.config).read_text()))
        params = params_model.model_validate(raw)
    except Exception:
        traceback.print_exc()
        return 1
    os.environ.setdefault("ADB_RUN_DIR", ".")
    try:
        run(params)
    except Exception:
        traceback.print_exc()
        for name, value in (fallback_summary or {}).items():
            metric(name=name, value=value)
    return 0


@contextlib.contextmanager
def protected_stream():
    """Keep the event stream flowing while a wrapped tool prints to stdout.

    Events emitted inside the block go to the real stdout (the JSONL channel);
    everything the wrapped tool prints goes to devnull. The pair to
    :func:`adb_events.emit.set_output`, packaged."""
    set_output(sys.stdout)
    try:
        with open(os.devnull, "w") as devnull, contextlib.redirect_stdout(devnull):
            yield
    finally:
        set_output(None)


def deposit_artifact(name: str, text: str, *, filename: str,
                     media_type: str | None = None) -> Path:
    """Write `text` into the run's ``artifacts/`` directory (layout.md) and emit
    the ``artifact`` event pointing at it (run-dir-relative path). Returns the
    written path."""
    art_dir = Path(os.environ.get("ADB_RUN_DIR", ".")) / "artifacts"
    art_dir.mkdir(parents=True, exist_ok=True)  # pre-created by the runner, not by bare CLI runs
    path = art_dir / filename
    path.write_text(text, encoding="utf-8")
    artifact(name=name, path=f"artifacts/{filename}", media_type=media_type,
             size=path.stat().st_size)
    return path
