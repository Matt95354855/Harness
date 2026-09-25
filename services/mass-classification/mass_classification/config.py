"""Validated runtime configuration. Secrets are never stored in code."""
import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    database_url: str
    data_dir: Path
    model_dir: Path
    embedding_model: str
    spacy_model: str
    asr_model: str
    max_upload_bytes: int
    allowed_origins: tuple[str, ...]
    device: str


def settings() -> Settings:
    return Settings(
        database_url=os.environ.get("DATABASE_URL", ""),
        data_dir=Path(os.environ.get("DATA_DIR", "./data")).resolve(),
        model_dir=Path(os.environ.get("MODEL_DIR", "./models")).resolve(),
        embedding_model=os.environ.get("EMBEDDING_MODEL", "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"),
        spacy_model=os.environ.get("SPACY_MODEL", "xx_ent_wiki_sm"),
        asr_model=os.environ.get("ASR_MODEL", "small"),
        max_upload_bytes=int(os.environ.get("MAX_UPLOAD_BYTES", "52428800")),
        allowed_origins=tuple(x.strip() for x in os.environ.get("ALLOWED_ORIGINS", "").split(",") if x.strip()),
        device=os.environ.get("MASS_DEVICE", "cpu"),
    )
