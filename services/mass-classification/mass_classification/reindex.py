"""Atomically rebuild one tenant's vectors and activate its validated local model."""
import argparse
from pathlib import Path
import re

from .config import settings
from .db import migrate, transaction
from .embedding import embed


def main():
    parser = argparse.ArgumentParser(description="Reindex one tenant during its maintenance window")
    parser.add_argument("--tenant", required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"[a-zA-Z0-9_-]{1,64}", args.tenant):
        parser.error("Invalid tenant")
    path = settings().model_dir / "tenants" / args.tenant / "embedding"
    if not path.is_dir() or not (path / "modules.json").is_file():
        parser.error(f"Validated SentenceTransformer model missing: {path}")
    embed(["dimension check"], str(path))
    # The tenant lock prevents worker writes and searches using a mixed index.
    # For very large tenants use a staged dual index instead of this maintenance tool.
    migrate()
    with transaction() as conn:
        if conn.execute("SELECT id FROM tenants WHERE id=%s FOR UPDATE", (args.tenant,)).fetchone() is None:
            parser.error("Unknown tenant")
        cursor = conn.execute("SELECT id,text FROM chunks WHERE tenant_id=%s ORDER BY id", (args.tenant,))
        count = 0
        while rows := cursor.fetchmany(32):
            vectors = embed([row["text"] for row in rows], str(path))
            for row, vector in zip(rows, vectors):
                conn.execute("UPDATE chunks SET embedding=%s WHERE tenant_id=%s AND id=%s",
                             (vector, args.tenant, row["id"]))
                count += 1
        conn.execute("UPDATE tenants SET embedding_model=%s WHERE id=%s", (str(path), args.tenant))
    print(f"tenant={args.tenant} reindexed_chunks={count} model={path}")


if __name__ == "__main__":
    main()
