"""Identity, date provenance and audit integrity invariants."""
from datetime import datetime, timezone
from uuid import uuid4

from mass_classification.analysis import classify
from mass_classification.db import event_hash
from mass_classification.entities import candidates
from mass_classification.temporal import timeline, source_time


def test_timeline_keeps_source_dates_distinct_from_import_dates():
    rows = [{"id": "one", "filename": "source", "status": "ready",
             "created_at": datetime(2026, 5, 1, tzinfo=timezone.utc),
             "source": {"event_at": "2026-04-01T12:00:00+02:00"}},
            {"id": "two", "filename": "import", "status": "ready",
             "created_at": datetime(2026, 4, 2, tzinfo=timezone.utc), "source": {}}]
    events = timeline(rows)
    assert [e["date_kind"] for e in events] == ["source_event", "import"]
    assert events[0]["at"] == "2026-04-01T10:00:00+00:00"
    assert source_time({"event_at": "2026-04-01"}) is None
    assert source_time({"event_at": "nonsense"}) is None


def test_entity_candidates_never_merge_different_types_or_equal_names():
    entities = [{"id": uuid4(), "canonical": "Alice Martin", "kind": "PER"},
                {"id": uuid4(), "canonical": "Alice Martine", "kind": "PER"},
                {"id": uuid4(), "canonical": "Alice Martin", "kind": "ORG"}]
    result = candidates(entities)
    assert len(result) == 1 and result[0]["status"] == "suggestion_only"


def test_audit_hash_changes_on_event_edit_or_tenant_swap():
    row = {"id": 7, "actor": "analyst", "action": "reviewed", "subject": "piece",
           "details": {"accepted": True}, "created_at": datetime.now(timezone.utc)}
    original = event_hash("0" * 64, "case-a", row)
    assert original != event_hash("0" * 64, "case-b", row)
    assert original != event_hash("0" * 64, "case-a", row | {"details": {"accepted": False}})


def test_explainable_rule_priority_matches_all_contributions():
    labels, explanation = classify({"money_mentions": 2}, "virement urgent urgent")
    assert labels["review_priority"] == sum(explanation["priority_contributions"].values())
    assert explanation["urgency_mentions"] == 2
