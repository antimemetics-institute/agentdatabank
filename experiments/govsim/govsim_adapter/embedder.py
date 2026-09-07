"""Embedders for GovSim's associative memory.

``hash`` (the keyless default): a deterministic sha256 → unit-vector embedder,
duck-typing upstream's ``EmbeddingModel`` (``embed`` / ``embed_retrieve``).
Explicit deviation from the paper: memory *relevance* becomes content-hash
noise, so retrieval ranking is driven by recency (0.99^i, w=0.5) and LLM-rated
importance (w=3); ``always_include`` nodes (agreed limits) are unaffected.

``mxbai``: the paper's ``mixedbread-ai/mxbai-embed-large-v1`` via
sentence-transformers — needs network (HF download, ~1.3 GB) or a warm
``HF_HOME``; never the prefilled path.
"""

from __future__ import annotations

import hashlib

import numpy as np

# upstream's dimension (mxbai-embed-large-v1); embeddings land in
# embeddings.json via upstream's NumpyEncoder, so plain ndarrays are required
_DIM = 1024
_RETRIEVE_PREFIX = "Represent this sentence for searching relevant passages: "


class HashEmbedder:
    """Deterministic, offline, nonzero-norm (cosine similarity divides by it)."""

    def embed(self, text: str) -> np.ndarray:
        digest = hashlib.sha256(text.encode("utf-8")).digest()
        rng = np.random.default_rng(int.from_bytes(digest[:8], "big"))
        vec = rng.standard_normal(_DIM)
        norm = np.linalg.norm(vec)
        return vec / norm if norm else vec

    def embed_retrieve(self, text: str) -> np.ndarray:
        # upstream's query prefix, kept so the hash space at least separates
        # queries from passages the way mxbai's prompt does
        return self.embed(f"{_RETRIEVE_PREFIX}{text}")


def make_embedder(kind: str):
    if kind == "hash":
        return HashEmbedder()
    if kind == "mxbai":
        # upstream's exact model; constructed lazily so the keyless path never
        # touches sentence-transformers' download machinery
        from simulation.persona import EmbeddingModel

        return EmbeddingModel(device="cpu")
    raise ValueError(f"unknown embedder: {kind!r} (expected 'hash' or 'mxbai')")
