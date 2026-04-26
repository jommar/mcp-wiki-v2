// scripts/setup-admin.js - One-time admin database bootstrap
// Creates the wiki_admin database if it doesn't already exist.
// Run once before the first `npm run admin`.
//
//   node scripts/setup-admin.js

import { config } from 'dotenv';
config();

import pg from 'pg';

const ADMIN_DB = 'wiki_admin';

const pool = new pg.Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT, 10) || 5433,
  user:     process.env.DB_USER     || 'wiki',
  password: process.env.DB_PASSWORD || 'wiki',
  database: 'postgres', // connect to default DB to run CREATE DATABASE
});

try {
  const { rows } = await pool.query(
    'SELECT 1 FROM pg_database WHERE datname = $1',
    [ADMIN_DB],
  );

  if (rows.length > 0) {
    console.log(`"${ADMIN_DB}" already exists — nothing to do.`);
  } else {
    await pool.query(`CREATE DATABASE "${ADMIN_DB}"`);
    console.log(`Created database "${ADMIN_DB}".`);
    console.log('Run "npm run admin" — it will create the api_keys table automatically.');
  }
} catch (err) {
  console.error('Setup failed:', err.message);
  process.exit(1);
} finally {
  await pool.end();
}
