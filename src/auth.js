// src/auth.js - API key verification against the admin DB (wiki_admin)
import pg from 'pg';
import { createHash } from 'node:crypto';

// Lazy-load verifyKey from the SaaS admin module so the server doesn't crash
// on branches where ../admin/ doesn't exist. Falls back to null (auth disabled).
let _verifyKey;
async function getVerifyKey() {
  if (_verifyKey !== undefined) return _verifyKey;
  try {
    const mod = await import('../admin/api-keys.js');
    _verifyKey = mod.verifyKey;
  } catch {
    _verifyKey = null;
  }
  return _verifyKey;
}

const ADMIN_DB = 'wiki_admin';
const CACHE_TTL = parseInt(process.env.AUTH_CACHE_TTL_MS, 10) || 5 * 60 * 1000; // 5 min default
const FAILED_CACHE_TTL = parseInt(process.env.AUTH_FAILED_CACHE_TTL_MS, 10) || 60_000; // 1 min

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT, 10) || 5433,
  user: process.env.DB_USER || 'wiki',
  password: process.env.DB_PASSWORD || 'wiki',
  database: ADMIN_DB,
  max: 2,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

// Cache: sha256(token) → { name, readonly, cachedAt }
// Keyed by a fast fingerprint so we don't expose the raw token in memory.
// TTL is configurable via AUTH_CACHE_TTL_MS env var (default 5 min).
// Use flushAuthCache() to manually clear on key revocation.
const cache = new Map();

// Failed-attempt cache: sha256(token) → cachedAt
// Prevents repeated O(N) bcrypt loops for invalid tokens (brute-force mitigation).
const failedCache = new Map();

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

  // Lazy-load verifyKey; null if ../admin/ doesn't exist on this branch
  const verifyKey = await getVerifyKey();
  if (!verifyKey) return null; // auth unavailable without the SaaS admin module

  // Check failed-attempt cache to avoid O(N) bcrypt on repeated invalid tokens
  const failedHit = failedCache.get(fingerprint);
  if (failedHit && Date.now() - failedHit < FAILED_CACHE_TTL) {
    return null;
  }

  // Verify against every active key (typically <100; bcrypt comparison each)
  const keys = await getActiveKeys();
  for (const k of keys) {
    if (verifyKey(token, k.key_hash)) {
      cache.set(fingerprint, { name: k.name, readonly: k.readonly, cachedAt: Date.now() });
      return { name: k.name, readonly: k.readonly };
    }
  }

  // Cache the failed attempt so we skip the bcrypt loop next time
  failedCache.set(fingerprint, Date.now());
  return null;
}

/** Clear all auth caches. Useful after key revocation — call this externally. */
export function flushAuthCache() {
  cache.clear();
  failedCache.clear();
}

/** Fire-and-forget: update last_used_at on successful auth. */
export async function touchKey(name) {
  await pool.query(`UPDATE api_keys SET last_used_at = NOW() WHERE name = $1`, [name]);
}
