"""Injected only into the docs GovSim adapter process by govsim-cache.mjs."""
import os
import sys

try:
    from cache import CacheFailure, Transcript
    from openai.resources.chat.completions import Completions
    from openai.types.chat import ChatCompletion

    transcript = Transcript(os.environ["ADB_DOCS_CACHE_MODE"], os.environ["ADB_DOCS_CACHE_PATH"])
    original_create = Completions.create

    def cached_create(self, *args, **kwargs):
        try:
            if args:
                raise CacheFailure("Unexpected positional SDK arguments")
            result = transcript.call(kwargs, lambda: original_create(self, **kwargs))
            return ChatCompletion.model_validate(result) if transcript.mode == "replay" else result
        except CacheFailure as error:
            # Upstream's finally blocks can mask SystemExit with their own error.
            # Fail at the process boundary so the runner sees an actual failure.
            print(str(error), file=sys.stderr, flush=True)
            os._exit(86)

    Completions.create = cached_create
    if transcript.mode == "replay":
        import httpx
        import socket

        def blocked_http(*args, **kwargs):
            raise CacheFailure("HTTP is disabled during offline GovSim replay")

        async def blocked_async_http(*args, **kwargs):
            raise CacheFailure("HTTP is disabled during offline GovSim replay")

        httpx.Client.send = blocked_http
        httpx.AsyncClient.send = blocked_async_http
        socket.socket.connect = blocked_http
        socket.socket.connect_ex = blocked_http
        socket.create_connection = blocked_http
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["TRANSFORMERS_OFFLINE"] = "1"
    print(f"[docs SDK cache: {transcript.mode}]", file=sys.stderr)
except BaseException as error:
    # Python normally ignores sitecustomize import failures and keeps running.
    # Abort instead, so a broken replay hook cannot accidentally make paid calls.
    print(f"GovSim SDK cache initialization failed: {type(error).__name__}: {error}", file=sys.stderr)
    os._exit(86)
