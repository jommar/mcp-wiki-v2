// src/migrate.js - Forward-only wiki schema migration runner
// Reads from sql/wiki/ — wiki schema only, not admin migrations.
// Two entry points:
//   runMigrations()          — global pool (stdio startup)
//   runWikiMigrations(pool)  — any pool (client DB first-connect)

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from './db.js';
import { logger } from '../logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WIKI_SQL_DIR = path.join(__dirname, '..', 'sql', 'wiki');

function getSqlFiles() {
  if (!fs.existsSync(WIKI_SQL_DIR)) return [];
  return fs.readdirSync(WIKI_SQL_DIR).filter((f) => f.endsWith('.sql')).sort();
}

async function applyMigrations(p) {
  await p.query(`
    CREATE TABLE IF NOT EXISTS migrations (
      filename   VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  const { rows } = await p.query('SELECT filename FROM migrations ORDER BY filename');
  const applied = new Set(rows.map((r) => r.filename));
  const files = getSqlFiles();

  // On a brand-new DB, mark nothing as applied — run everything.
  // (No "mark existing as applied" shortcut — client DBs start empty.)
  const pending = files.filter((f) => !applied.has(f));
  if (pending.length === 0) {
    logger.info('Migrations: up to date');
    return;
  }

  for (const file of pending) {
    const sql = fs.readFileSync(path.join(WIKI_SQL_DIR, file), 'utf-8');
    logger.info('Migrations: applying', { file });
    await p.query('BEGIN');
    try {
      await p.query(sql);
      await p.query('INSERT INTO migrations (filename) VALUES ($1)', [file]);
      await p.query('COMMIT');
      logger.info('Migrations: applied', { file });
    } catch (err) {
      await p.query('ROLLBACK');
      logger.error('Migrations: failed', { file, error: err.message });
      throw err;
    }
  }

  logger.info('Migrations: complete', { applied: pending.length });
}

/** Run wiki schema migrations on the global (stdio) pool. */
export async function runMigrations() {
  await applyMigrations(pool);
}

/** Run wiki schema migrations on a given client pool. */
export async function runWikiMigrations(clientPool) {
  await applyMigrations(clientPool);
}
