"""Offline tests: python3 -m unittest discover -s scripts/docs-gif/govsim-cache."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from cache import CacheFailure, Transcript


class SyntheticCompletion:
    def __init__(self, text):
        self.data = {
            "id": "chatcmpl-synthetic", "object": "chat.completion", "created": 1,
            "model": "synthetic-model", "choices": [{"index": 0, "finish_reason": "stop",
                "message": {"role": "assistant", "content": text}}],
            "usage": {"prompt_tokens": 12, "completion_tokens": 3, "total_tokens": 15},
        }

    def model_dump(self, *, mode):
        assert mode == "json"
        return self.data


class TranscriptTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "cache.jsonl"
        self.request = {"model": "synthetic-model", "messages": [{"role": "user", "content": "hi"}],
                        "temperature": 0.5, "top_p": 1, "max_tokens": 100, "seed": 42}

    def record(self):
        recorder = Transcript("record", self.path)
        self.addCleanup(recorder.output.close)
        return recorder

    def test_exact_round_trip_and_occurrences(self):
        recorder = self.record()
        for text in ["first", "second"]:
            response = SyntheticCompletion(text)
            self.assertIs(recorder.call(self.request, lambda: response), response)
        replay = Transcript("replay", self.path)
        for text in ["first", "second"]:
            self.assertEqual(replay.call(dict(reversed(list(self.request.items()))), self.fail), SyntheticCompletion(text).data)
        with self.assertRaises(CacheFailure):
            replay.call(self.request, self.fail)
        rows = [json.loads(line) for line in self.path.read_text().splitlines()]
        self.assertEqual(rows[1]["request"], self.request)
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)

    def test_generation_change_fails_without_live_fallback(self):
        self.record().call(self.request, lambda: SyntheticCompletion("answer"))
        replay = Transcript("replay", self.path)
        with self.assertRaises(CacheFailure):
            replay.call({**self.request, "temperature": 0.7}, self.fail)
        self.assertFalse(issubclass(CacheFailure, Exception))

    def test_optional_miss_file_preserves_exact_unmatched_request(self):
        self.record().call(self.request, lambda: SyntheticCompletion("answer"))
        replay = Transcript("replay", self.path)
        target = Path(self.directory.name) / "miss.json"
        changed = {**self.request, "seed": 99}
        with patch.dict(os.environ, {"ADB_DOCS_CACHE_MISS_PATH": str(target)}):
            with self.assertRaises(CacheFailure):
                replay.call(changed, self.fail)
        self.assertEqual(json.loads(target.read_text()), {"unmatched_request": changed})
        self.assertEqual(target.stat().st_mode & 0o777, 0o600)

    def test_credentials_streaming_and_overwrite_rejected(self):
        recorder = self.record()
        for extra in [{"extra_headers": {"Authorization": "secret"}}, {"stream": True}]:
            with self.assertRaises(CacheFailure):
                recorder.call({**self.request, **extra}, self.fail)
        self.assertNotIn("secret", self.path.read_text())
        with self.assertRaises(FileExistsError):
            Transcript("record", self.path)

    def test_site_hook_reconstructs_sdk_response_and_blocks_network(self):
        # Fake SDK exposes the real import surface without installing OpenAI or
        # contacting any provider. Its live implementation is a tripwire.
        root = Path(self.directory.name)
        files = {
            "openai/__init__.py": "",
            "openai/resources/__init__.py": "",
            "openai/resources/chat/__init__.py": "",
            "openai/resources/chat/completions.py": "class Completions:\n def create(self, **kwargs):\n  raise AssertionError('live SDK called')\n",
            "openai/types/__init__.py": "",
            "openai/types/chat.py": "class ChatCompletion:\n @classmethod\n def model_validate(cls, data):\n  result = cls(); result.data = data; return result\n",
            "httpx.py": "class Client:\n pass\nclass AsyncClient:\n pass\n",
        }
        for name, content in files.items():
            target = root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content)
        self.record().call(self.request, lambda: SyntheticCompletion("answer"))
        env = {**os.environ, "PYTHONPATH": os.pathsep.join([str(root), str(Path(__file__).parent.resolve())]),
               "ADB_DOCS_CACHE_MODE": "replay", "ADB_DOCS_CACHE_PATH": str(self.path),
               "PYTHONDONTWRITEBYTECODE": "1"}
        program = f"""
from openai.resources.chat.completions import Completions
from openai.types.chat import ChatCompletion
import socket
response = Completions().create(**{self.request!r})
assert isinstance(response, ChatCompletion)
assert response.data['usage']['total_tokens'] == 15
try:
    socket.create_connection(('localhost', 1))
except SystemExit:
    pass
else:
    raise AssertionError('network was not blocked')
# Exhaustion must escape ordinary Exception handlers used by upstream GovSim.
try:
    Completions().create(**{self.request!r})
except Exception:
    raise AssertionError('cache failure swallowed')
"""
        child = subprocess.run([sys.executable, "-c", program], env=env, capture_output=True, text=True)
        self.assertEqual(child.returncode, 86, child.stderr)
        self.assertIn("Offline SDK cache miss", child.stderr)
        env["ADB_DOCS_CACHE_PATH"] = str(root / "missing.jsonl")
        child = subprocess.run([sys.executable, "-c", "raise AssertionError('startup continued')"], env=env, capture_output=True, text=True)
        self.assertEqual(child.returncode, 86, child.stderr)
        self.assertIn("initialization failed", child.stderr)


if __name__ == "__main__":
    unittest.main()
