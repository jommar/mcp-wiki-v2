-- 004_api_keys.sql - API key management for multi-tenant HTTP access

CREATE TABLE IF NOT EXISTS api_keys (
  id            SERIAL PRIMARY KEY,
  name          VARCHAR(100) NOT NULL,
  key_prefix    VARCHAR(8) NOT NULL,              -- "wk_v2_" for visual identification
  key_hash      TEXT NOT NULL UNIQUE,               -- bcrypt hash of the full key
  wiki_ids      TEXT[] NOT NULL DEFAULT '{}',      -- wikis this key can access; '{}' = all
  readonly      BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys (key_hash);
CREATE INDEX IF NOT EXISTS idx_api_keys_revoked ON api_keys (revoked_at) WHERE revoked_at IS NOT NULL;
