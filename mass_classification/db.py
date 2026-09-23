"""Database transactions, migration and tenant scoped read/write helpers."""
from contextlib import contextmanager
from pathlib import Path

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


def migrate() -> None:
    # Migration 001 is idempotent. An advisory lock serializes startup across replicas.
    sql = (Path(__file__).resolve().parent / "migrations" / "001_initial.sql").read_text()
    with pool().connection() as conn:
        with conn.transaction():
            conn.execute("SELECT pg_advisory_xact_lock(17290319)")
            conn.execute(sql)


def audit(conn, tenant: str, actor: str, action: str, subject: str, details: dict | None = None) -> None:
    from psycopg.types.json import Jsonb
    conn.execute(
        "INSERT INTO audit_events(tenant_id,actor,action,subject,details) VALUES (%s,%s,%s,%s,%s)",
        (tenant, actor, action, subject, Jsonb(details or {})),
    )
