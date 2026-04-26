import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pkg from 'pg';
const { Pool } = pkg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DB = process.env.TEST_DB_NAME || 'wiki_test';
const TEST_DIR = path.resolve(__dirname, '../../import/staging');
const TEST_WIKI = 'wiki-test-import';

let testPool;

// ─── Module-level setup (runs before any tests) ──────────────────────────────

// 1. Create the test DB schema so the global pool (loaded next) can use it
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

// 2. Create schema in test DB
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
await setupPool.end();

// 3. Point the global pool to test DB and import the module
process.env.DB_NAME = TEST_DB;
const { importFile } = await import('../../src/import.js');

// Ensure staging dir exists
fs.mkdirSync(TEST_DIR, { recursive: true });

// ─── Helpers ─────────────────────────────────────────────────────────────────

function writeTestFile(content) {
  const filePath = path.join(TEST_DIR, `${TEST_WIKI}.md`);
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

function cleanTestFile(filePath) {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    /* ignore */
  }
}

// ─── Setup / Teardown ────────────────────────────────────────────────────────

before(() => {
  testPool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT, 10) || 5433,
    user: process.env.DB_USER || 'wiki',
    password: process.env.DB_PASSWORD || 'wiki',
    database: TEST_DB,
    max: 2,
  });
});

after(async () => {
  // Clean up test data
  if (testPool) {
    await testPool.query('DELETE FROM wiki_sections WHERE wiki_id = $1', [TEST_WIKI]);
    await testPool.query('DELETE FROM wiki_sections WHERE wiki_id = $1', ['custom-wiki']);
    await testPool.end();
  }
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('importFile — async readFile', () => {
  it('imports a valid markdown file and creates a section', async () => {
    const content = `---
key: test-async-read
parent: Async Topic
title: Async Read Test
---
This section was imported via async readFile.
`;
    const filePath = writeTestFile(content);
    try {
      const result = await importFile(filePath);
      assert.equal(result.imported, true);
      assert.equal(result.sections, 1);
      assert.equal(result.wikiId, TEST_WIKI);

      // Verify section exists in DB
      const { rows } = await testPool.query(
        'SELECT key, parent, title, content FROM wiki_sections WHERE wiki_id = $1 AND key = $2',
        [TEST_WIKI, 'test-async-read'],
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0].title, 'Async Read Test');
      assert.equal(rows[0].content, 'This section was imported via async readFile.');
    } finally {
      cleanTestFile(filePath);
      await testPool.query('DELETE FROM wiki_sections WHERE wiki_id = $1 AND key = $2', [
        TEST_WIKI,
        'test-async-read',
      ]);
    }
  });
});

describe('importFile — wiki_id frontmatter override', () => {
  it('uses wiki_id from frontmatter when present', async () => {
    const content = `---
key: test-wiki-id-override
parent: Override Topic
title: Wiki ID Override
wiki_id: custom-wiki
---
This should go to custom-wiki, not the filename-derived wiki.
`;
    const filePath = writeTestFile(content);
    try {
      const result = await importFile(filePath);
      assert.equal(result.imported, true);
      assert.equal(result.wikiId, 'custom-wiki');

      // Verify section is in custom-wiki
      const { rows } = await testPool.query(
        'SELECT wiki_id, key FROM wiki_sections WHERE wiki_id = $1 AND key = $2',
        ['custom-wiki', 'test-wiki-id-override'],
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0].wiki_id, 'custom-wiki');
    } finally {
      cleanTestFile(filePath);
      await testPool.query('DELETE FROM wiki_sections WHERE wiki_id = $1 AND key = $2', [
        'custom-wiki',
        'test-wiki-id-override',
      ]);
    }
  });

  it('falls back to filename-derived wiki_id when frontmatter has no wiki_id', async () => {
    const content = `---
key: test-no-override
parent: Normal Topic
title: No Override
---
This should use the filename-derived wiki_id.
`;
    const filePath = writeTestFile(content);
    try {
      const result = await importFile(filePath);
      assert.equal(result.imported, true);
      assert.equal(result.wikiId, TEST_WIKI);

      const { rows } = await testPool.query(
        'SELECT wiki_id FROM wiki_sections WHERE wiki_id = $1 AND key = $2',
        [TEST_WIKI, 'test-no-override'],
      );
      assert.equal(rows.length, 1);
    } finally {
      cleanTestFile(filePath);
      await testPool.query('DELETE FROM wiki_sections WHERE wiki_id = $1 AND key = $2', [
        TEST_WIKI,
        'test-no-override',
      ]);
    }
  });

  it('ignores invalid wiki_id in frontmatter (falls back to filename)', async () => {
    const content = `---
key: test-invalid-wiki-id
parent: Invalid Topic
title: Invalid Wiki ID
wiki_id: has spaces and Uppercase!
---
Invalid wiki_id should be ignored.
`;
    const filePath = writeTestFile(content);
    try {
      const result = await importFile(filePath);
      assert.equal(result.imported, true);
      // Invalid wiki_id should fall back to filename-derived value
      assert.equal(result.wikiId, TEST_WIKI);
    } finally {
      cleanTestFile(filePath);
      await testPool.query('DELETE FROM wiki_sections WHERE wiki_id = $1 AND key = $2', [
        TEST_WIKI,
        'test-invalid-wiki-id',
      ]);
    }
  });
});
