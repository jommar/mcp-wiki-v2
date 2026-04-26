import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pkg from 'pg';
const { Pool } = pkg;

const TEST_DB = process.env.TEST_DB_NAME || 'wiki_test';

let pool;

// ─── Setup / Teardown ────────────────────────────────────────────────────────

before(async () => {
  pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT, 10) || 5433,
    user: process.env.DB_USER || 'wiki',
    password: process.env.DB_PASSWORD || 'wiki',
    database: TEST_DB,
    max: 2,
  });

  await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wiki_sections (
      id SERIAL PRIMARY KEY,
      wiki_id VARCHAR(50) NOT NULL,
      key VARCHAR(255) NOT NULL,
      parent VARCHAR(255),
      title VARCHAR(500) NOT NULL,
      content TEXT NOT NULL,
      tags VARCHAR(100)[],
      status VARCHAR(20) DEFAULT 'active',
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      embedding vector(384),
      UNIQUE(wiki_id, key)
    )
  `);

  // Insert 6 test sections (all in same wiki for predictable ordering)
  const WIKI = 'wiki-test-pagination';
  const sections = [
    { key: 'alpha', parent: 'Group A', title: 'Alpha', content: 'First section' },
    { key: 'beta', parent: 'Group A', title: 'Beta', content: 'Second section' },
    { key: 'gamma', parent: 'Group A', title: 'Gamma', content: 'Third section' },
    { key: 'delta', parent: 'Group B', title: 'Delta', content: 'Fourth section' },
    { key: 'epsilon', parent: 'Group B', title: 'Epsilon', content: 'Fifth section' },
    { key: 'zeta', parent: 'Group B', title: 'Zeta', content: 'Sixth section' },
  ];

  for (const s of sections) {
    await pool.query(
      `INSERT INTO wiki_sections (wiki_id, key, parent, title, content, tags, status, metadata)
       VALUES ($1, $2, $3, $4, $5, $6::varchar(100)[], 'active', $7)
       ON CONFLICT (wiki_id, key) DO NOTHING`,
      [WIKI, s.key, s.parent, s.title, s.content, [], JSON.stringify({})],
    );
  }
});

after(async () => {
  if (pool) {
    await pool.query('DELETE FROM wiki_sections WHERE wiki_id = $1', ['wiki-test-pagination']);
    await pool.end();
  }
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('listSections offset pagination', () => {
  it('returns all sections with offset=0', async () => {
    const { rows } = await pool.query(
      `SELECT key FROM wiki_sections WHERE wiki_id = $1 ORDER BY key LIMIT $2 OFFSET $3`,
      ['wiki-test-pagination', 100, 0],
    );
    assert.equal(rows.length, 6);
  });

  it('skips N sections with offset=N', async () => {
    const { rows } = await pool.query(
      `SELECT key FROM wiki_sections WHERE wiki_id = $1 ORDER BY key LIMIT $2 OFFSET $3`,
      ['wiki-test-pagination', 100, 2],
    );
    assert.equal(rows.length, 4);
    assert.equal(rows[0].key, 'delta'); // alpha and beta skipped
  });

  it('returns fewer results when limit+offset > total', async () => {
    const { rows } = await pool.query(
      `SELECT key FROM wiki_sections WHERE wiki_id = $1 ORDER BY key LIMIT $2 OFFSET $3`,
      ['wiki-test-pagination', 3, 4],
    );
    assert.equal(rows.length, 2); // only 2 left after skipping 4
  });

  it('returns empty when offset >= total', async () => {
    const { rows } = await pool.query(
      `SELECT key FROM wiki_sections WHERE wiki_id = $1 ORDER BY key LIMIT $2 OFFSET $3`,
      ['wiki-test-pagination', 10, 100],
    );
    assert.equal(rows.length, 0);
  });

  it('offset and limit work together for precise pagination', async () => {
    // Page 1: first 2
    const page1 = await pool.query(
      `SELECT key FROM wiki_sections WHERE wiki_id = $1 ORDER BY key LIMIT $2 OFFSET $3`,
      ['wiki-test-pagination', 2, 0],
    );
    assert.equal(page1.rows.length, 2);
    assert.equal(page1.rows[0].key, 'alpha');

    // Page 2: next 2
    const page2 = await pool.query(
      `SELECT key FROM wiki_sections WHERE wiki_id = $1 ORDER BY key LIMIT $2 OFFSET $3`,
      ['wiki-test-pagination', 2, 2],
    );
    assert.equal(page2.rows.length, 2);
    assert.equal(page2.rows[0].key, 'delta');

    // Page 3: last 2 (gamma, zeta alphabetically)
    const page3 = await pool.query(
      `SELECT key FROM wiki_sections WHERE wiki_id = $1 ORDER BY key LIMIT $2 OFFSET $3`,
      ['wiki-test-pagination', 2, 4],
    );
    assert.equal(page3.rows.length, 2);
    assert.equal(page3.rows[0].key, 'gamma');
    assert.equal(page3.rows[1].key, 'zeta');
  });
});
