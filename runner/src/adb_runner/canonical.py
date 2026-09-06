"""Condition identity per docs/book/src/running/model.md.

condition_id = sha256(JCS({experiment, source, params})), derived client-side.
"""

from __future__ import annotations

import hashlib
from typing import Any

import rfc8785


def condition_id(experiment: str, source: str, params: dict[str, Any]) -> str:
    payload = {"experiment": experiment, "source": source, "params": params}
    return hashlib.sha256(rfc8785.dumps(payload)).hexdigest()


def abbrev(cid: str) -> str:
    return cid[:12]
