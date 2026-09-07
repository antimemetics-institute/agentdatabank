"""Local, credential-free SDK transcript; independent of production code."""
import hashlib
import json
import os
from collections import defaultdict, deque


class CacheFailure(SystemExit):
    """Do not let GovSim's recovery from ordinary API errors hide cache misses."""


def encode(value):
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, (list, tuple)):
        return [encode(item) for item in value]
    if isinstance(value, dict):
        if any(key.lower() in {"authorization", "api_key", "extra_headers", "headers"} for key in value):
            raise CacheFailure("Refusing to record request headers or credentials")
        return {key: encode(item) for key, item in value.items()}
    if type(value).__module__.startswith("openai") and type(value).__name__ in {"NotGiven", "Omit"}:
        return {"__openai_sentinel__": type(value).__name__}
    if hasattr(value, "model_dump"):
        return encode(value.model_dump(mode="json"))
    raise CacheFailure(f"Unsupported SDK argument type: {type(value).__name__}")


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


class Transcript:
    def __init__(self, mode, path):
        self.mode = mode
        self.entries = defaultdict(deque)
        if mode == "record":
            # Never append to or replace a paid run, even after a failed attempt.
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            self.output = os.fdopen(fd, "w", encoding="utf-8")
            self.write({"format": "adb-docs-govsim-sdk-v1", "api": "chat.completions.create", "mode": "record"})
        elif mode == "replay":
            with open(path, encoding="utf-8") as source:
                metadata = json.loads(next(source))
                if metadata != {"format": "adb-docs-govsim-sdk-v1", "api": "chat.completions.create", "mode": "record"}:
                    raise CacheFailure("Unsupported SDK transcript format")
                for line in source:
                    row = json.loads(line)
                    self.entries[canonical(row["request"])].append(row["response"])
        else:
            raise CacheFailure("Expected record or replay")

    def write(self, row):
        self.output.write(canonical(row) + "\n")
        self.output.flush()
        os.fsync(self.output.fileno())

    def call(self, kwargs, live):
        request = encode(kwargs)
        if kwargs.get("stream"):
            raise CacheFailure("Streaming responses are not supported by this transcript")
        if self.mode == "record":
            response = live()
            self.write({"request": request, "response": response.model_dump(mode="json")})
            return response
        key = canonical(request)
        if not self.entries[key]:
            digest = hashlib.sha256(key.encode()).hexdigest()
            miss_path = os.environ.get("ADB_DOCS_CACHE_MISS_PATH")
            if miss_path:
                fd = os.open(miss_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(fd, "w", encoding="utf-8") as destination:
                    destination.write(canonical({"unmatched_request": request}) + "\n")
            raise CacheFailure(f"Offline SDK cache miss ({digest}); no live fallback")
        return self.entries[key].popleft()
