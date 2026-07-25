"""Minimal ULID: 48-bit ms timestamp + 80 random bits, Crockford base32."""

from __future__ import annotations

import os
import time

_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"


def ulid() -> str:
    value = (int(time.time() * 1000) & ((1 << 48) - 1)) << 80
    value |= int.from_bytes(os.urandom(10), "big")
    chars = []
    for shift in range(125, -1, -5):
        chars.append(_ALPHABET[(value >> shift) & 0x1F])
    return "".join(chars)
