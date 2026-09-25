"""Database transactions, migration and tenant scoped read/write helpers."""
from contextlib import contextmanager
from pathlib import Path
import hashlib
import json

import psycopg
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool
from pgvector.psycopg import register_vector

from .config import settings

_pool: ConnectionPool | None = None


def pool() -> ConnectionPool:
    global _pool
    if _pool is None:
        url = settings().database_url
        if not url:
            raise RuntimeError("DATABASE_URL is required")
        _pool = ConnectionPool(url, min_size=1, max_size=10, kwargs={"row_factory": dict_row}, open=True)
        _pool.wait()
    return _pool


@contextmanager
def transaction():
    with pool().connection() as conn:
        register_vector(conn)
        with conn.transaction():
            yield conn


def tenant_embedding(conn, tenant: str, *, lock: bool = False) -> str:
    """Resolve the approved model for exactly one workspace."""
    row = conn.execute("SELECT embedding_model FROM tenants WHERE id=%s" + (" FOR SHARE" if lock else ""),
                       (tenant,)).fetchone()
    if row is None:
        raise ValueError("Unknown tenant")
    return row["embedding_model"] or settings().embedding_model


def migrate() -> None:
    # All migrations are idempotent; serialize startup across replicas.
    with pool().connection() as conn:
        with conn.transaction():
            conn.execute("SELECT pg_advisory_xact_lock(17290319)")
            for path in sorted((Path(__file__).resolve().parent / "migrations").glob("*.sql")):
                conn.execute(path.read_text())


def event_hash(previous: str, tenant: str, event: dict) -> str:
    record = {"previous": previous, "tenant": tenant, "id": event["id"],
              "actor": event["actor"], "action": event["action"], "subject": event["subject"],
              "details": event["details"], "created_at": event["created_at"].isoformat()}
    return hashlib.sha256(json.dumps(record, ensure_ascii=False, sort_keys=True,
                                     separators=(",", ":")).encode()).hexdigest()


def audit(conn, tenant: str, actor: str, action: str, subject: str, details: dict | None = None) -> None:
    from psycopg.types.json import Jsonb
    # Separate per-tenant lock avoids serializing unrelated search/model reads.
    conn.execute("INSERT INTO audit_heads(tenant_id) VALUES (%s) ON CONFLICT DO NOTHING", (tenant,))
    conn.execute("SELECT tenant_id FROM audit_heads WHERE tenant_id=%s FOR UPDATE", (tenant,))
    previous = conn.execute("SELECT sequence,event_hash FROM audit_chain WHERE tenant_id=%s ORDER BY sequence DESC LIMIT 1",
                            (tenant,)).fetchone()
    row = conn.execute("INSERT INTO audit_events(tenant_id,actor,action,subject,details) VALUES (%s,%s,%s,%s,%s) "
                       "RETURNING id,actor,action,subject,details,created_at",
                       (tenant, actor, action, subject, Jsonb(details or {}))).fetchone()
    digest = event_hash(previous["event_hash"] if previous else "0" * 64, tenant, row)
    conn.execute("INSERT INTO audit_chain(tenant_id,sequence,event_id,previous_hash,event_hash) VALUES (%s,%s,%s,%s,%s)",
                 (tenant, previous["sequence"] + 1 if previous else 1, row["id"],
                  previous["event_hash"] if previous else "0" * 64, digest))


def verify_audit(conn, tenant: str) -> dict:
    rows = conn.execute("SELECT c.sequence,c.previous_hash,c.event_hash,e.id,e.actor,e.action,e.subject,e.details,e.created_at "
                        "FROM audit_chain c JOIN audit_events e ON e.id=c.event_id AND e.tenant_id=c.tenant_id "
                        "WHERE c.tenant_id=%s ORDER BY c.sequence", (tenant,)).fetchall()
    previous = "0" * 64
    for index, row in enumerate(rows, 1):
        if row["sequence"] != index or row["previous_hash"] != previous or event_hash(previous, tenant, row) != row["event_hash"]:
            return {"valid": False, "checked": index - 1, "failed_sequence": index}
        previous = row["event_hash"]
    legacy = conn.execute("SELECT count(*) AS total FROM audit_events e LEFT JOIN audit_chain c ON c.event_id=e.id "
                          "WHERE e.tenant_id=%s AND c.event_id IS NULL", (tenant,)).fetchone()["total"]
    return {"valid": True, "checked": len(rows), "legacy_unsealed": legacy, "head_hash": previous}
