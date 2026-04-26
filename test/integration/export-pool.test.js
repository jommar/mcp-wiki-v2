// test/integration/export-pool.test.js — Integration test for exportWiki with custom pool
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pkg from 'pg';
const { Pool } = pkg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DB = process.env.TEST_DB_NAME || 'wiki_test';
const TEST_WIKI = 'wiki-test-export-pool';
const OUTPUT_DIR = path.resolve(__dirname, '../../export');

let testPool;

// ─── Setup ───────────────────────────────────────────────────────────────────

const adminPool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT, 10) || 5433,
  user: process.env.DB_USER || 'wiki',
  password: process.env.DB_PASSWORD || 'wiki',
  database: 'postgres',
  max: 1,
});

try {
  const { rows } = await adminPool.query('SELECT 1 FROM pg_database WHERE datname = $1', [TEST_DB]);
  if (rows.length === 0) {
    await adminPool.query(`CREATE DATABASE "${TEST_DB.replace(/"/g, '""')}"`);
  }
} finally {
  await adminPool.end();
}

const setupPool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT, 10) || 5433,
  user: process.env.DB_USER || 'wiki',
  password: process.env.DB_PASSWORD || 'wiki',
  database: TEST_DB,
  max: 1,
});
await setupPool.query('CREATE EXTENSION IF NOT EXISTS vector');
await setupPool.query(`
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
await setupPool.query(`
  CREATE TABLE IF NOT EXISTS section_links (
    id SERIAL PRIMARY KEY,
    from_wiki_id VARCHAR(50) NOT NULL,
    from_key VARCHAR(255) NOT NULL,
    to_wiki_id VARCHAR(50) NOT NULL,
    to_key VARCHAR(255) NOT NULL,
    UNIQUE(from_wiki_id, from_key, to_wiki_id, to_key)
  )
`);
await setupPool.end();

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('exportWiki — custom pool parameter', () => {
  before(async () => {
    testPool = new Pool({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT, 10) || 5433,
      user: process.env.DB_USER || 'wiki',
      password: process.env.DB_PASSWORD || 'wiki',
      database: TEST_DB,
      max: 2,
    });

    // Seed test data
    await testPool.query('DELETE FROM wiki_sections WHERE wiki_id = $1', [TEST_WIKI]);
    await testPool.query(
      `
      INSERT INTO wiki_sections (wiki_id, key, parent, title, content, tags, status, metadata)
      VALUES
        ($1, 'sec-a', 'Topic A', 'Section A', 'Content A', ARRAY['test'], 'active', '{}'),
        ($1, 'sec-b', 'Topic A', 'Section B', 'Content B', ARRAY['test'], 'active', '{}'),
        ($1, 'sec-c', 'Topic B', 'Section C', 'Content C', ARRAY['test'], 'active', '{}')
    `,
      [TEST_WIKI],
    );
  });

  after(async () => {
    await testPool.query('DELETE FROM wiki_sections WHERE wiki_id = $1', [TEST_WIKI]);

    // Clean up exported files
    const exportedPath = path.join(OUTPUT_DIR, `${TEST_WIKI}.md`);
    try {
      fs.unlinkSync(exportedPath);
    } catch {
      /* ignore */
    }

    await testPool.end();
  });

  it('exports sections using a custom pool', async () => {
    const { exportWiki } = await import('../../src/export.js');

    fs.mkdirSync(OUTPUT_DIR, { recursive: true });

    const result = await exportWiki(TEST_WIKI, OUTPUT_DIR, { pool: testPool });

    assert.equal(result.wikiId, TEST_WIKI);
    assert.equal(result.exported, 3);
    assert.ok(result.filePath);
    assert.ok(result.filePath.endsWith(`${TEST_WIKI}.md`));

    // Verify the file content
    const content = fs.readFileSync(result.filePath, 'utf8');
    assert.ok(content.includes('key: sec-a'));
    assert.ok(content.includes('Content A'));
    assert.ok(content.includes('key: sec-c'));
    assert.ok(content.includes('Content C'));
    assert.ok(content.includes('# Topic A'));
    assert.ok(content.includes('# Topic B'));
  });

  it('returns zero exported for empty wiki', async () => {
    const { exportWiki } = await import(`../../src/export.js?empty=${Date.now()}`);

    const result = await exportWiki('nonexistent-wiki', OUTPUT_DIR, { pool: testPool });

    assert.equal(result.wikiId, 'nonexistent-wiki');
    assert.equal(result.exported, 0);
    assert.equal(result.filePath, null);
  });
});
