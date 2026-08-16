"""Manifest loading, defaults merge, and validation.

Two-phase validation: a spec check before hashing (unknown params, missing required
values, type mismatches), then a check on realized params before launch, where
instantiation checks (minLen, …) also run. In the MVP spec and realized params are
identical (there are no distributions yet); the phases are kept because their error
surfaces differ — spec errors are usage errors (exit 2), realized errors fail the
run. Types describe shape; everything pydantic-ish happens here at instantiation.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, cast

from adb_events import Json

# The runner's open documents, named so each signature says WHICH one it takes.
# Param VALUES are `Json` (the real recursive union from adb_events), so an
# isinstance narrows to an honest type (list[Json], dict[str, Json]) instead of
# pyright's Unknown — no casts at the narrowing sites. The manifest and its type
# descriptors stay dict[str, Any]: author-shaped documents this module validates
# values AGAINST, read loosely by design.
type Manifest = dict[str, Any]
type Params = dict[str, Json]
type TypeDesc = dict[str, Any]


class SchemaError(ValueError):
    pass


def load_manifest(path: str | Path) -> Manifest:
    manifest = json.loads(Path(path).read_text())
    for field in ("name", "params"):
        if field not in manifest:
            raise SchemaError(f"manifest missing {field!r}")
    return manifest


class MissingParamsError(SchemaError):
    def __init__(self, missing: list[str]):
        super().__init__(f"every param must be bound explicitly; missing {missing}")
        self.missing = missing


def bind_params(manifest: Manifest, overrides: Params) -> Params:
    """Every param must be bound by the invocation — there are NO experiment-level
    defaults. A manifest's `initial` values are presentation only (the composer's
    prefill, and the suggested oneliner the CLI prints on this error): they never
    silently enter a run, so an author changing one can never change what an
    existing oneliner means."""
    params_schema = manifest["params"]
    unknown = set(overrides) - set(params_schema)
    if unknown:
        raise SchemaError(f"unknown params {sorted(unknown)}; known: {sorted(params_schema)}")
    missing = sorted(set(params_schema) - set(overrides))
    if missing:
        raise MissingParamsError(missing)
    return {name: overrides[name] for name in params_schema}


def _type_error(path: str, tdesc: TypeDesc, value: Any) -> SchemaError:
    return SchemaError(f"{path}: expected {tdesc.get('kind')}, got {value!r}")


def field_type(fdesc: Json) -> TypeDesc:
    """A struct field is a bare type descriptor ({"kind": ...}), or a param-wrapped one
    ({"type": {...}, "suggestions": [...], ...}) when the author attached presentation
    hints. Validation only cares about the type."""
    if isinstance(fdesc, dict):
        if "kind" not in fdesc:
            inner = fdesc.get("type")
            if isinstance(inner, dict):
                return inner
        return fdesc
    # not a mapping at all — malformed; hand it back for validate_value to raise on
    return cast("TypeDesc", fdesc)


def validate_value(value: Json, tdesc: TypeDesc, path: str) -> None:
    """Strict validation of a fully-concrete value against a type descriptor."""
    kind = tdesc["kind"]
    if kind in ("llm", "str"):
        if not isinstance(value, str):
            raise _type_error(path, tdesc, value)
    elif kind == "int":
        if not isinstance(value, int) or isinstance(value, bool):
            raise _type_error(path, tdesc, value)
    elif kind == "float":
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            raise _type_error(path, tdesc, value)
    elif kind == "bool":
        if not isinstance(value, bool):
            raise _type_error(path, tdesc, value)
    elif kind == "enum":
        if value not in tdesc["values"]:
            raise SchemaError(f"{path}: {value!r} not in enum {tdesc['values']}")
    elif kind == "list":
        if not isinstance(value, list):
            raise _type_error(path, tdesc, value)
        for i, item in enumerate(value):
            validate_value(item, tdesc["of"], f"{path}[{i}]")
    elif kind == "struct":
        if not isinstance(value, dict):
            raise _type_error(path, tdesc, value)
        fields = tdesc["fields"]
        if set(value) != set(fields):
            raise SchemaError(
                f"{path}: struct fields {sorted(value)} != schema fields {sorted(fields)}"
            )
        for fname, ftype in fields.items():
            validate_value(value[fname], field_type(ftype), f"{path}.{fname}")
    elif kind == "object":
        # a free-form JSON object — arbitrary keys/values (e.g. a wrapped tool's
        # -T/generate args). Materialized as written into the condition hash.
        if not isinstance(value, dict):
            raise _type_error(path, tdesc, value)
    else:
        raise SchemaError(f"{path}: unknown type kind {kind!r}")


def validate_spec(params: Params, manifest: Manifest) -> None:
    for name, value in params.items():
        pschema = manifest["params"][name]
        if value is None and pschema.get("nullable"):
            continue  # explicit null on a nullable param — a bound value, not an omission
        validate_value(value, pschema["type"], name)


def validate_realized(params: Params, manifest: Manifest) -> None:
    for name, value in params.items():
        pschema = manifest["params"][name]
        if value is None and pschema.get("nullable"):
            continue
        validate_value(value, pschema["type"], name)
        if isinstance(value, list):
            n = len(value)
            min_len = pschema.get("minLen")
            if min_len is not None and n < min_len:
                raise SchemaError(f"{name}: length {n} < minLen {min_len}")
            max_len = pschema.get("maxLen")
            if max_len is not None and n > max_len:
                raise SchemaError(f"{name}: length {n} > maxLen {max_len}")
