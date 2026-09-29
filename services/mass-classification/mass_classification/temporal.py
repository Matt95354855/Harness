"""Explicit source dates and import dates, kept separate for evidentiary review."""
from datetime import datetime, timezone


def source_time(source: dict) -> str | None:
    """Accept only an ISO 8601 timestamp with an explicit offset from provenance."""
    value = source.get("event_at")
    if not isinstance(value, str) or len(value) > 40:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed.astimezone(timezone.utc).isoformat() if parsed.tzinfo else None


def timeline(rows: list[dict]) -> list[dict]:
    """Order bounded document events; never mistake the import date for an event date."""
    result = []
    for row in rows:
        explicit = source_time(row.get("source") or {})
        imported = row["created_at"]
        result.append({"document_id": row["id"], "filename": row["filename"],
                       "at": explicit or (imported.isoformat() if hasattr(imported, "isoformat") else imported),
                       "date_kind": "source_event" if explicit else "import",
                       "status": row["status"]})
    return sorted(result, key=lambda event: (event["at"], str(event["document_id"])))
