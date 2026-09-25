"""Local administrator commands; raw keys are displayed once, never stored."""
import argparse
import hashlib
import secrets
import uuid
import re

from .db import migrate, transaction, audit


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="command", required=True)
    key = sub.add_parser("create-key")
    key.add_argument("--tenant", required=True)
    key.add_argument("--role", choices=("admin", "analyst", "reader"), default="analyst")
    revoke = sub.add_parser("revoke-key")
    revoke.add_argument("--key-id", required=True, type=uuid.UUID)
    args = p.parse_args()
    if args.command == "create-key" and not re.fullmatch(r"[a-zA-Z0-9_-]{1,64}", args.tenant):
        raise SystemExit("Tenant must be 1-64 ASCII letters, numbers, underscores or hyphens")
    migrate()
    with transaction() as conn:
        if args.command == "create-key":
            token = "mc_" + secrets.token_urlsafe(32)
            key_id = uuid.uuid4()
            conn.execute("INSERT INTO tenants(id) VALUES (%s) ON CONFLICT DO NOTHING", (args.tenant,))
            conn.execute("INSERT INTO api_keys(id,tenant_id,key_hash,role) VALUES (%s,%s,%s,%s)",
                         (key_id, args.tenant, hashlib.sha256(token.encode()).hexdigest(), args.role))
            audit(conn, args.tenant, "system", "key_created", str(key_id), {"role": args.role})
            print(f"key_id={key_id}\ntoken={token}")
        else:
            row = conn.execute("UPDATE api_keys SET active=false WHERE id=%s RETURNING tenant_id", (args.key_id,)).fetchone()
            if row is None:
                raise SystemExit("Unknown key ID")
            audit(conn, row["tenant_id"], "system", "key_revoked", str(args.key_id))
            print("revoked")


if __name__ == "__main__":
    main()
