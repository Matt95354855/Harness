"""Public classification capability contract for the unified platform."""
from pathlib import Path


CAPABILITY_VERSION = "classification-capabilities:v1"
ACCEPTED_EXTENSIONS = frozenset({".pdf", ".docx"})


def validate_classification_filename(filename: str) -> str:
    """Return a safe basename when the unified workflow supports the input."""
    name = Path(filename or "unnamed").name[:200]
    if Path(name).suffix.lower() not in ACCEPTED_EXTENSIONS:
        raise ValueError("Only PDF and DOCX documents are accepted")
    return name


def classification_capabilities(*, max_upload_bytes: int, ocr_available: bool,
                                approved_model_available: bool) -> dict:
    """Describe installed behavior without claiming unavailable model capability."""
    return {
        "version": CAPABILITY_VERSION,
        "workflow": "document-super-classification",
        "execution": {"mode": "asynchronous", "human_review_supported": True},
        "inputs": [
            {
                "extension": ".pdf",
                "mime_types": ["application/pdf"],
                "content": ["text", "images", "tables"],
            },
            {
                "extension": ".docx",
                "mime_types": ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
                "content": ["text", "images", "tables"],
            },
        ],
        "limits": {"max_upload_bytes": max_upload_bytes, "max_pdf_pages": 1000},
        "preprocessing": {
            "strategy": "ocr_first",
            "required": True,
            "stages": [
                {
                    "order": 1,
                    "name": "ocr",
                    "engine": "tesseract",
                    "status": "available" if ocr_available else "unavailable",
                    "applies_to": ["pdf_pages", "docx_embedded_images"],
                },
                {
                    "order": 2,
                    "name": "native_structure_extraction",
                    "status": "available",
                    "applies_to": ["pdf_text", "docx_text", "docx_tables"],
                },
                {"order": 3, "name": "normalization_and_chunking", "status": "available"},
            ],
            "table_limits": {
                "docx": "native_cell_text",
                "pdf": "ocr_text_without_guaranteed_cell_structure",
            },
        },
        "classification": {
            "rules": {"status": "available", "version": "rules:v1"},
            "topological_model": {
                "status": "available" if approved_model_available else "unavailable",
                "requires_approved_checkpoint": True,
            },
            "abstention_supported": True,
            "evidence_and_provenance": True,
        },
    }
