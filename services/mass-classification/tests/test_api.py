"""Unit-level security contracts independent of a live PostgreSQL service."""
import hashlib
import uuid

import pytest
from fastapi import HTTPException

import mass_classification.api as api


def test_bearer_auth_requires_correct_key_and_is_tenant_scoped(monkeypatch):
    expected = hashlib.sha256(b"mc_valid" ).hexdigest()
    class Connection:
        def execute(self, sql, params):
            assert params == (expected,)
            assert "active=true" in sql
            return self
        def fetchone(self):
            return {"id": uuid.uuid4(), "tenant_id": "case_1", "role": "reader"}
    from contextlib import contextmanager
    @contextmanager
    def fake_transaction():
        yield Connection()
    monkeypatch.setattr(api, "transaction", fake_transaction)
    assert api.principal("Bearer mc_valid").tenant == "case_1"
    with pytest.raises(HTTPException) as error:
        api.principal("invalid")
    assert error.value.status_code == 401


def test_role_rejection():
    checker = api.require("admin")
    with pytest.raises(HTTPException) as error:
        checker(api.Principal(tenant="a", role="reader", key_id=uuid.uuid4()))
    assert error.value.status_code == 403
