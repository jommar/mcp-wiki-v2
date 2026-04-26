// src/client-pool.js - Per-client DB pool management
// Each authenticated API key maps to its own PostgreSQL database (name = key name).
// Pools are created on first use and cached with an idle timeout.
// Wiki schema migrations run automatically on first connect.

import pkg from 'pg';
const { Pool } = pkg;
import { logger } from '../logger.js';
import { runWikiMigrations } from './migrate.js';

// ─── Configuration ───────────────────────────────────────────────────────────

const DB_CONFIG = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT, 10) || 5433,
  user: process.env.DB_USER || 'wiki',
  password: process.env.DB_PASSWORD || 'wiki',
};

const DEFAULT_POOL_MAX = parseInt(process.env.CLIENT_POOL_MAX, 10) || 5;
const POOL_IDLE_TIMEOUT_MS = parseInt(process.env.POOL_IDLE_TIMEOUT_MS, 10) || 30 * 60 * 1000; // 30 min
const SWEEP_INTERVAL_MS = parseInt(process.env.POOL_SWEEP_INTERVAL_MS, 10) || 5 * 60 * 1000; // 5 min

// ─── Pool store ──────────────────────────────────────────────────────────────

// Map<dbName, { pool: Pool, createdAt: number, lastUsedAt: number }>
const pools = new Map();

// Get (or create) a client DB pool. Runs migrations on first connect.
export async function getClientPool(dbName) {
  const entry = pools.get(dbName);
  if (entry) {
    entry.lastUsedAt = Date.now();
    return entry.pool;
  }

  const pool = new Pool({
    ...DB_CONFIG,
    database: dbName,
    max: DEFAULT_POOL_MAX,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  try {
    await pool.query('CREATE EXTENSION IF NOT EXISTS fuzzystrmatch').catch((err) => {
      logger.warn('Failed to create fuzzystrmatch extension', { db: dbName, error: err.message });
    });
    await runWikiMigrations(pool);
    pools.set(dbName, { pool, createdAt: Date.now(), lastUsedAt: Date.now() });
    logger.info('Client DB ready', { db: dbName, poolMax: DEFAULT_POOL_MAX });
  } catch (err) {
    logger.error('Client DB init failed', { db: dbName, error: err.message });
    await pool.end().catch(() => {});
    throw err;
  }

  return pool;
}

// Release and drain a specific client pool. New calls to getClientPool will re-create it.
export async function releaseClientPool(dbName) {
  const entry = pools.get(dbName);
  if (!entry) return false;

  pools.delete(dbName);
  try {
    await entry.pool.end();
    logger.info('Client DB pool released', { db: dbName });
    return true;
  } catch (err) {
    logger.error('Failed to release client DB pool', { db: dbName, error: err.message });
    return false;
  }
}

// Drain and release all client pools. Called during server shutdown.
export async function drainAllPools() {
  if (pools.size === 0) return;

  const entries = [...pools.keys()];
  logger.info(`Draining ${entries.length} client DB pool(s)...`);

  const results = await Promise.allSettled(entries.map((name) => releaseClientPool(name)));

  const failed = results.filter((r) => r.status === 'rejected' || r.value === false).length;
  if (failed > 0) {
    logger.warn(`Failed to drain ${failed} client DB pool(s)`);
  }
}

// Get count of active client pools.
export function getPoolCount() {
  return pools.size;
}

function sweepStalePools() {
  const cutoff = Date.now() - POOL_IDLE_TIMEOUT_MS;
  const stale = [...pools.keys()].filter((name) => pools.get(name).lastUsedAt < cutoff);
  if (stale.length === 0) return;

  stale.forEach((name) => releaseClientPool(name).catch(() => {}));
  logger.info(`Sweeping ${stale.length} stale client DB pool(s)`, {
    idleTimeoutMs: POOL_IDLE_TIMEOUT_MS,
    activePools: pools.size,
  });
}

// ─── Periodic sweep ──────────────────────────────────────────────────────────

const sweepTimer = setInterval(sweepStalePools, SWEEP_INTERVAL_MS);
sweepTimer.unref();

// ─── Test support ────────────────────────────────────────────────────────────

/** Clear all pools WITHOUT draining (for test cleanup only). */
export function __test__clearPools() {
  pools.clear();
}
