// src/migrate.js - Forward-only migration runner
// Runs on server startup. Applies new SQL files from sql/ directory.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from './db.js';
import { logger } from '../logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SQL_DIR = path.join(__dirname, '..', 'sql');

async function ensureMigrationsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS migrations (
      filename VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

async function getAppliedFiles() {
  const { rows } = await pool.query('SELECT filename FROM migrations ORDER BY filename');
  return new Set(rows.map((r) => r.filename));
}

async function getSqlFiles() {
  if (!fs.existsSync(SQL_DIR)) return [];
  return fs
    .readdirSync(SQL_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort(); // Lexicographic sort ensures 001 before 002
}

export async function runMigrations() {
  await ensureMigrationsTable();

  const applied = await getAppliedFiles();
  const files = await getSqlFiles();

  // On first run, mark all existing files as already applied.
  // They were applied via docker-entrypoint-initdb.d or manually.
  if (applied.size === 0 && files.length > 0) {
    for (const f of files) {
      await pool.query('INSERT INTO migrations (filename) VALUES ($1)', [f]);
      applied.add(f);
    }
    logger.info('Migrations: marked existing SQL files as already applied', { count: files.length });
  }

  // Find and apply new files
  const pending = files.filter((f) => !applied.has(f));
  if (pending.length === 0) {
    logger.info('Migrations: no pending migrations');
    return;
  }

  for (const file of pending) {
    const filePath = path.join(SQL_DIR, file);
    const sql = fs.readFileSync(filePath, 'utf-8');

    logger.info('Migrations: applying', { file });
    await pool.query('BEGIN');
    try {
      await pool.query(sql);
      await pool.query('INSERT INTO migrations (filename) VALUES ($1)', [file]);
      await pool.query('COMMIT');
      logger.info('Migrations: applied', { file });
    } catch (err) {
      await pool.query('ROLLBACK');
      logger.error('Migrations: failed', { file, error: err.message });
      throw err; // Fail fast — don't continue if a migration breaks
    }
  }

  logger.info('Migrations: complete', { applied: pending.length });
}
