// src/auth.js - API key verification against the admin DB (wiki_admin)
import pg from 'pg';
import { createHash } from 'node:crypto';
import { verifyKey } from '../admin/api-keys.js';

const ADMIN_DB = 'wiki_admin';
const CACHE_TTL = 5 * 60 * 1000; // 5 min — re-verify after revoke can propagate

const pool = new pg.Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT, 10) || 5433,
  user:     process.env.DB_USER     || 'wiki',
  password: process.env.DB_PASSWORD || 'wiki',
  database: ADMIN_DB,
  max: 2,
  idleTimeoutMillis:     30_000,
  connectionTimeoutMillis: 5_000,
});

// Cache: sha256(token) → { name, readonly, cachedAt }
// Keyed by a fast fingerprint so we don't expose the raw token in memory.
const cache = new Map();

async function getActiveKeys() {
  const { rows } = await pool.query(
    `SELECT name, key_hash, readonly FROM api_keys WHERE revoked_at IS NULL`,
  );
  return rows;
}

/**
 * Verify a bearer token against the admin DB.
 * Returns { name, readonly } on success, null on failure.
 */
export async function authenticateToken(token) {
  if (!token?.startsWith('wk_v2_')) return null;

  const fingerprint = createHash('sha256').update(token).digest('hex');

  const hit = cache.get(fingerprint);
  if (hit && Date.now() - hit.cachedAt < CACHE_TTL) {
    return { name: hit.name, readonly: hit.readonly };
  }

  // Verify against every active key (typically <100; 1000× SHA-256 each)
  const keys = await getActiveKeys();
  for (const k of keys) {
    if (verifyKey(token, k.key_hash)) {
      cache.set(fingerprint, { name: k.name, readonly: k.readonly, cachedAt: Date.now() });
      return { name: k.name, readonly: k.readonly };
    }
  }

  return null;
}

/** Fire-and-forget: update last_used_at on successful auth. */
export async function touchKey(name) {
  await pool.query(
    `UPDATE api_keys SET last_used_at = NOW() WHERE name = $1`,
    [name],
  );
}
