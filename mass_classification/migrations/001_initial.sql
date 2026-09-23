CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS tenants (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS api_keys (
  id uuid PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id), key_hash text NOT NULL UNIQUE,
  role text NOT NULL CHECK (role IN ('admin','analyst','reader')), active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz
);
CREATE TABLE IF NOT EXISTS documents (
  id uuid PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id), filename text NOT NULL,
  mime text NOT NULL, sha256 text NOT NULL, byte_size bigint NOT NULL, source jsonb NOT NULL DEFAULT '{}',
  content text NOT NULL DEFAULT '', language text, metadata jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL CHECK (status IN ('queued','processing','ready','failed')),
  error text, created_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz,
  model_version text, UNIQUE(tenant_id, sha256)
);
CREATE INDEX IF NOT EXISTS documents_tenant_created ON documents (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS documents_search ON documents USING gin (to_tsvector('simple', content));
CREATE TABLE IF NOT EXISTS jobs (
  id uuid PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id), document_id uuid NOT NULL REFERENCES documents(id),
  status text NOT NULL CHECK (status IN ('queued','running','done','failed')),
  attempts integer NOT NULL DEFAULT 0, max_attempts integer NOT NULL DEFAULT 3,
  next_attempt_at timestamptz NOT NULL DEFAULT now(), lease_until timestamptz,
  error text, created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS jobs_available ON jobs (next_attempt_at, created_at) WHERE status IN ('queued','running');
CREATE TABLE IF NOT EXISTS chunks (
  id uuid PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id), document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  ordinal integer NOT NULL, text text NOT NULL, embedding vector(384), UNIQUE(document_id, ordinal)
);
CREATE INDEX IF NOT EXISTS chunks_tenant_document ON chunks (tenant_id, document_id);
-- Build ANN index only after loading representative data; exact search works at any scale.
CREATE TABLE IF NOT EXISTS entities (
  id uuid PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id), canonical text NOT NULL,
  kind text NOT NULL, aliases jsonb NOT NULL DEFAULT '[]', UNIQUE(tenant_id, kind, canonical)
);
CREATE TABLE IF NOT EXISTS mentions (
  tenant_id text NOT NULL REFERENCES tenants(id), document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  entity_id uuid NOT NULL REFERENCES entities(id), start_offset integer NOT NULL, end_offset integer NOT NULL,
  PRIMARY KEY (document_id, entity_id, start_offset)
);
CREATE TABLE IF NOT EXISTS relations (
  id uuid PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id), source_id uuid NOT NULL REFERENCES entities(id),
  target_id uuid NOT NULL REFERENCES entities(id), document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  kind text NOT NULL, confidence real NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  evidence text NOT NULL, extractor text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS relations_tenant ON relations (tenant_id, source_id, target_id);
CREATE TABLE IF NOT EXISTS analyses (
  document_id uuid PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE, tenant_id text NOT NULL REFERENCES tenants(id),
  labels jsonb NOT NULL DEFAULT '{}', signals jsonb NOT NULL DEFAULT '{}', topology jsonb NOT NULL DEFAULT '{}',
  predictions jsonb NOT NULL DEFAULT '{}', explanation jsonb NOT NULL DEFAULT '{}', model_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS feedback (
  id uuid PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id), document_id uuid NOT NULL REFERENCES documents(id),
  actor_key_id uuid NOT NULL REFERENCES api_keys(id), label text NOT NULL, accepted boolean NOT NULL,
  comment text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS audit_events (
  id bigserial PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id), actor text NOT NULL,
  action text NOT NULL, subject text NOT NULL, details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_events_tenant ON audit_events (tenant_id, created_at DESC);
-- The API runs with one database service account. Every application query MUST filter by tenant_id.
-- Grant direct database access only to infrastructure operators, never to API clients.
