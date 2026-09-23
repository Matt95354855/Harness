-- Chain only new events; pre-existing audit_events remain accessible as legacy rows.
CREATE TABLE IF NOT EXISTS audit_chain (
  tenant_id text NOT NULL REFERENCES tenants(id), sequence bigint NOT NULL,
  event_id bigint NOT NULL UNIQUE REFERENCES audit_events(id),
  previous_hash text NOT NULL, event_hash text NOT NULL,
  PRIMARY KEY (tenant_id, sequence)
);
CREATE TABLE IF NOT EXISTS audit_heads (
  tenant_id text PRIMARY KEY REFERENCES tenants(id)
);
CREATE TABLE IF NOT EXISTS entity_aliases (
  tenant_id text NOT NULL REFERENCES tenants(id), kind text NOT NULL,
  alias text NOT NULL, entity_id uuid NOT NULL REFERENCES entities(id),
  reviewer_key_id uuid NOT NULL REFERENCES api_keys(id), created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, kind, alias)
);
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS embedding_model text;
