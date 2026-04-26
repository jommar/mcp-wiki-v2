// src/client-pool.js - Per-client DB pool management
// Each authenticated API key maps to its own PostgreSQL database (name = key name).
// Pools are created on first use and cached for the lifetime of the process.
// Wiki schema migrations run automatically on first connect.

import pkg from 'pg';
const { Pool } = pkg;
import { logger } from '../logger.js';
import { runWikiMigrations } from './migrate.js';

const pools = new Map(); // dbName → pg.Pool

export async function getClientPool(dbName) {
  if (pools.has(dbName)) return pools.get(dbName);

  const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT, 10) || 5433,
    user: process.env.DB_USER || 'wiki',
    password: process.env.DB_PASSWORD || 'wiki',
    database: dbName,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  try {
    await pool.query('CREATE EXTENSION IF NOT EXISTS fuzzystrmatch').catch((err) => {
      logger.warn('Failed to create fuzzystrmatch extension', { db: dbName, error: err.message });
    });
    await runWikiMigrations(pool);
    pools.set(dbName, pool);
    logger.info('Client DB ready', { db: dbName });
  } catch (err) {
    logger.error('Client DB init failed', { db: dbName, error: err.message });
    await pool.end().catch(() => {});
    throw err;
  }

  return pool;
}
