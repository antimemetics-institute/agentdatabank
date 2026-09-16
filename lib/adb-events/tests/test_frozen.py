"""Frozen v0 data models must remain byte-for-byte reproducible."""

from hashlib import sha256
import json
from pathlib import Path


def test_frozen_schema_modules_are_unchanged():
    root = Path(__file__).parents[1] / "adb_events"
    hashes = json.loads(Path(__file__).with_name("frozen.json").read_text())
    assert set(hashes) == {"inspect_chat.py", "models/llm.py"}
    for filename, expected in hashes.items():
        assert sha256((root / filename).read_bytes()).hexdigest() == expected, (
            f"{filename}: frozen schema modules are not edited; "
            "a new module and schema version are added instead."
        )


def test_shared_payloads_do_not_declare_envelope_keys():
    from adb_events import EVENT_MODELS

    envelope_keys = {"v", "ts", "run", "experiment", "schema", "seq"}
    for model in set(EVENT_MODELS.values()):
        names = {field.alias or name for name, field in model.model_fields.items()}
        assert not (names & envelope_keys), (model.__name__, names & envelope_keys)
