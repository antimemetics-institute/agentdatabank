"""Manifest conformance sweep — every real nix-built manifest against the schema
vocabulary in adb_runner.schema (the python twin of web/src/shared/types.ts).

Full structural validation, driven by the TypedDicts themselves (annotations are
introspected, so there is no second schema to drift): at every level, keys must
be declared, required keys present, and every VALUE must match its annotated
type — a manifest with `order: "1"` or a string where a list belongs fails here
with the file and path in the message. (msgspec would do this in one call but
rejects untagged TypedDict unions like StructField, hence the small walker.)

Gated on ADB_TEST_MANIFESTS (task test:python wires it to the nix-built manifests
dir, same as the web suite's sweep); skips without it.
"""

import json
import os
import types
import typing
from pathlib import Path

import pytest

from adb_events import Json
from adb_runner.schema import Manifest

# kinds the nix `types` constructors can produce (plus the reserved run/harness
# vocabulary types.ts already names for the GUI)
KINDS = {"llm", "str", "int", "float", "bool", "enum", "list", "struct", "object",
         "run", "harness"}


def _check(value: object, ann: object, path: str) -> None:
    """Assert `value` matches the annotation — TypedDicts (keys + required +
    recursive field types), list/dict generics, unions (first matching arm),
    scalars. `Json` means any JSON: it IS the deliberate don't-care."""
    if ann is Json:
        return
    if isinstance(ann, typing.TypeAliasType):  # `type X = ...` statements
        _check(value, ann.__value__, path)
        return
    origin = typing.get_origin(ann)
    if origin is typing.NotRequired:
        _check(value, typing.get_args(ann)[0], path)
        return
    if typing.is_typeddict(ann):
        assert isinstance(value, dict), f"{path}: expected object, got {type(value).__name__}"
        hints = typing.get_type_hints(ann)
        unknown = set(value) - set(hints)
        assert not unknown, f"{path}: keys {sorted(unknown)} not declared on {ann.__name__}"
        missing = ann.__required_keys__ - set(value)
        assert not missing, f"{path}: required keys {sorted(missing)} missing"
        for k, v in value.items():
            _check(v, hints[k], f"{path}.{k}")
        return
    if origin in (typing.Union, types.UnionType):
        errors: list[str] = []
        for arm in typing.get_args(ann):
            try:
                _check(value, arm, path)
                return
            except AssertionError as exc:
                errors.append(str(exc))
        raise AssertionError(f"{path}: {value!r} matches no arm of {ann}: {errors}")
    if origin is list:
        assert isinstance(value, list), f"{path}: expected list, got {type(value).__name__}"
        (item_ann,) = typing.get_args(ann)
        for i, item in enumerate(value):
            _check(item, item_ann, f"{path}[{i}]")
        return
    if origin is dict:
        assert isinstance(value, dict), f"{path}: expected object, got {type(value).__name__}"
        _key_ann, val_ann = typing.get_args(ann)
        for k, v in value.items():
            _check(v, val_ann, f"{path}.{k}")
        return
    if isinstance(ann, type):
        if ann is int:  # bool is an int subclass; keep them distinct
            assert isinstance(value, int) and not isinstance(value, bool), \
                f"{path}: expected int, got {type(value).__name__}"
        else:
            assert isinstance(value, ann), \
                f"{path}: expected {ann.__name__}, got {type(value).__name__}"
        return
    raise AssertionError(f"{path}: annotation {ann!r} not handled by this walker")


def _kinds(node: object) -> typing.Iterator[str]:
    if isinstance(node, dict):
        for k, v in node.items():
            if k == "kind" and isinstance(v, str):
                yield v
            yield from _kinds(v)
    elif isinstance(node, list):
        for item in node:
            yield from _kinds(item)


def test_every_shipped_manifest_conforms():
    manifests_dir = os.environ.get("ADB_TEST_MANIFESTS")
    if not manifests_dir:
        pytest.skip("ADB_TEST_MANIFESTS unset (run via `task test:python`)")
    files = sorted(Path(manifests_dir).glob("*.json"))
    assert files, f"no manifests in {manifests_dir}"
    for f in files:
        doc = json.loads(f.read_text())
        _check(doc, Manifest, f.name)
        unknown_kinds = set(_kinds(doc["params"])) - KINDS
        assert not unknown_kinds, f"{f.name}: unknown kinds {sorted(unknown_kinds)}"


def test_walker_rejects_wrong_types():
    """The walker itself must catch value-type drift, not just keys."""
    good = {"name": "x", "params": {"p": {"type": {"kind": "int"}, "order": 1}}}
    _check(good, Manifest, "good")
    _check({**good, "readme": "# Experiment\n\nDocumentation."}, Manifest, "readme")
    for bad, why in [
        ({**good, "name": 1}, "name must be str"),
        ({**good, "readme": 1}, "readme must be str when present"),
        ({**good, "params": {"p": {"type": {"kind": "int"}, "order": "1"}}}, "order must be int"),
        ({**good, "params": {"p": {"type": {"kind": "enum", "values": "ab"}}}}, "values must be a list"),
        ({**good, "params": {"p": {"kind": "int"}}}, "decl missing required 'type'"),
    ]:
        with pytest.raises(AssertionError):
            _check(bad, Manifest, why)


def test_shipped_readme_is_embedded_in_catalog():
    manifests_dir = os.environ.get("ADB_TEST_MANIFESTS")
    if not manifests_dir:
        pytest.skip("ADB_TEST_MANIFESTS unset (run via `task test:python`)")
    root = Path(__file__).resolve().parents[2]
    catalog = Path(manifests_dir)
    govsim = json.loads((catalog / "govsim.json").read_text())
    assert govsim["readme"] == (root / "experiments/govsim/README.md").read_text()
    # An experiment directory without a README stays valid and omits the field.
    if not (root / "experiments/inspect_evals/README.md").exists():
        assert "readme" not in json.loads((catalog / "inspect-hello.json").read_text())
