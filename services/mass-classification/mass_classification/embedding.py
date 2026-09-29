"""Lazy local multilingual embeddings; reproducible model identity and dimensions."""
from functools import lru_cache
import numpy as np


@lru_cache(maxsize=2)
def model(name: str):
    from sentence_transformers import SentenceTransformer
    from .config import settings
    device = settings().device
    if device not in {"cpu", "cuda"}:
        raise ValueError("MASS_DEVICE must be cpu or cuda")
    if device == "cuda":
        import torch
        if not torch.cuda.is_available():
            raise RuntimeError("MASS_DEVICE=cuda requested but CUDA is unavailable")
    return SentenceTransformer(name, device=device)


def embed(texts: list[str], name: str) -> np.ndarray:
    if not texts:
        return np.empty((0, 384), dtype=np.float32)
    vectors = model(name).encode(texts, batch_size=32, normalize_embeddings=True, show_progress_bar=False)
    vectors = np.asarray(vectors, dtype=np.float32)
    if vectors.ndim != 2 or vectors.shape[1] != 384:
        raise ValueError("Configured embedding model must output 384 dimensions; migrate schema before changing models")
    return vectors
