// src/ensure-db.js - Auto-create the wiki database on stdio startup
// Connects to the 'postgres' default DB, checks pg_database for DB_NAME,
// and creates it if missing. No-op in HTTP mode (client DBs are handled elsewhere).
// Idempotent — safe to run every startup.

import pg from 'pg';
import { logger } from '../logger.js';

export async function ensureDatabase() {
  const mode = process.env.TRANSPORT || 'stdio';
  if (mode === 'http') return; // HTTP mode manages DBs via client-pool.js

  const dbName = process.env.DB_NAME || 'wiki';
  const host = process.env.DB_HOST || 'localhost';
  const port = parseInt(process.env.DB_PORT, 10) || 5433;
  const user = process.env.DB_USER || 'wiki';
  const password = process.env.DB_PASSWORD || 'wiki';

  // Connect to the 'postgres' bootstrap database to inspect/create the target
  const pool = new pg.Pool({
    host,
    port,
    user,
    password,
    database: 'postgres',
    max: 1,
    connectionTimeoutMillis: 5_000,
  });

  try {
    const { rows } = await pool.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [dbName],
    );

    if (rows.length > 0) {
      logger.info('Database exists', { database: dbName });
      return;
    }

    await pool.query(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`);
    logger.info('Database created', { database: dbName });
  } finally {
    await pool.end();
  }
}
