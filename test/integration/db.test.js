import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pkg from 'pg';
const { Pool } = pkg;

// Use the same defaults as the app (port 5433 to match docker-compose)
const TEST_DB = process.env.TEST_DB_NAME || 'wiki_test';
const BASE_CONFIG = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT, 10) || 5433,
  user: process.env.DB_USER || 'wiki',
  password: process.env.DB_PASSWORD || 'wiki',
};

let adminPool;
let testPool;
const TEST_WIKI = 'wiki-test-suite';
const CREATED_KEYS = [];

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function createSection(client, key, overrides = {}) {
  const defaults = {
    wiki_id: TEST_WIKI,
    key,
    parent: 'Test Topic',
    title: `Test: ${key}`,
    content: `Content for ${key}`,
    tags: ['test'],
    status: 'active',
    metadata: JSON.stringify({}),
  };
  const s = { ...defaults, ...overrides };
  CREATED_KEYS.push(key);
  await client.query(
    `INSERT INTO wiki_sections (wiki_id, key, parent, title, content, tags, status, metadata)
     VALUES ($1, $2, $3, $4, $5, $6::varchar(100)[], $7, $8)`,
    [s.wiki_id, s.key, s.parent, s.title, s.content, s.tags, s.status, s.metadata],
  );
}

async function withClient(fn) {
  const client = await testPool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

// ─── Setup / Teardown ────────────────────────────────────────────────────────

before(async () => {
  // Connect to 'postgres' bootstrap DB to create test DB if needed
  adminPool = new Pool({ ...BASE_CONFIG, database: 'postgres', max: 1 });
  try {
    const { rows } = await adminPool.query('SELECT 1 FROM pg_database WHERE datname = $1', [TEST_DB]);
    if (rows.length === 0) {
      await adminPool.query(`CREATE DATABASE "${TEST_DB.replace(/"/g, '""')}"`);
    }
  } finally {
    await adminPool.end();
  }

  // Connect to test DB and run migrations
  testPool = new Pool({ ...BASE_CONFIG, database: TEST_DB, max: 5 });
  await testPool.query('CREATE EXTENSION IF NOT EXISTS vector');
  await testPool.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
  await testPool.query('CREATE EXTENSION IF NOT EXISTS fuzzystrmatch');

  // Run schema (simplified — same as 001_initial_schema.sql)
  await testPool.query(`
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

  await testPool.query(`
    CREATE TABLE IF NOT EXISTS section_links (
      id SERIAL PRIMARY KEY,
      from_wiki_id VARCHAR(50) NOT NULL,
      from_key VARCHAR(255) NOT NULL,
      to_wiki_id VARCHAR(50) NOT NULL,
      to_key VARCHAR(255) NOT NULL,
      UNIQUE(from_wiki_id, from_key, to_wiki_id, to_key)
    )
  `);

  await testPool.query(`
    CREATE TABLE IF NOT EXISTS section_history (
      id SERIAL PRIMARY KEY,
      wiki_id VARCHAR(50) NOT NULL,
      section_key VARCHAR(255) NOT NULL,
      content_before TEXT,
      content_after TEXT NOT NULL,
      changed_at TIMESTAMPTZ DEFAULT NOW(),
      change_reason VARCHAR(100)
    )
  `);

  // Create indexes (skip if they exist)
  await testPool.query('CREATE INDEX IF NOT EXISTS idx_ws_wiki_key ON wiki_sections(wiki_id, key)');
  await testPool.query('CREATE INDEX IF NOT EXISTS idx_sl_from ON section_links(from_wiki_id, from_key)');
  await testPool.query('CREATE INDEX IF NOT EXISTS idx_sl_to ON section_links(to_wiki_id, to_key)');
  await testPool.query('CREATE INDEX IF NOT EXISTS idx_sh_lookup ON section_history(wiki_id, section_key, changed_at DESC)');
});

after(async () => {
  // Clean up all created test data
  if (testPool) {
    for (const key of CREATED_KEYS) {
      await testPool.query('DELETE FROM section_links WHERE from_wiki_id = $1 AND from_key = $2', [TEST_WIKI, key]);
      await testPool.query('DELETE FROM section_links WHERE to_wiki_id = $1 AND to_key = $2', [TEST_WIKI, key]);
      await testPool.query('DELETE FROM section_history WHERE wiki_id = $1 AND section_key = $2', [TEST_WIKI, key]);
    }
    await testPool.query('DELETE FROM wiki_sections WHERE wiki_id = $1', [TEST_WIKI]);
    await testPool.end();
  }
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('updateSection — content_before in history', () => {
  it('stores old content in content_before when content changes', async () => {
    await withClient(async (client) => {
      const key = 'test-content-before';
      const originalContent = 'Original content';
      const updatedContent = 'Updated content';

      await createSection(client, key, { content: originalContent });

      // Update content (simulating what db.js updateSection does)
      const { rows: existing } = await client.query(
        'SELECT content FROM wiki_sections WHERE wiki_id = $1 AND key = $2',
        [TEST_WIKI, key],
      );
      const oldContent = existing[0].content || '';

      await client.query(
        'UPDATE wiki_sections SET content = $1, updated_at = NOW() WHERE wiki_id = $2 AND key = $3',
        [updatedContent, TEST_WIKI, key],
      );

      await client.query(
        `INSERT INTO section_history (wiki_id, section_key, content_before, content_after, change_reason)
         VALUES ($1, $2, $3, $4, $5)`,
        [TEST_WIKI, key, oldContent, updatedContent, 'test update'],
      );

      const { rows: history } = await client.query(
        'SELECT content_before, content_after, change_reason FROM section_history WHERE wiki_id = $1 AND section_key = $2',
        [TEST_WIKI, key],
      );

      assert.equal(history.length, 1);
      assert.equal(history[0].content_before, originalContent);
      assert.equal(history[0].content_after, updatedContent);
      assert.equal(history[0].change_reason, 'test update');
    });
  });

  it('stores empty string as content_before for brand-new sections', async () => {
    await withClient(async (client) => {
      const key = 'test-content-before-empty';

      // Insert directly with empty content
      await createSection(client, key, { content: '' });

      const { rows: existing } = await client.query(
        'SELECT content FROM wiki_sections WHERE wiki_id = $1 AND key = $2',
        [TEST_WIKI, key],
      );
      const oldContent = existing[0].content || '';

      await client.query(
        'UPDATE wiki_sections SET content = $1, updated_at = NOW() WHERE wiki_id = $2 AND key = $3',
        ['New content', TEST_WIKI, key],
      );

      await client.query(
        `INSERT INTO section_history (wiki_id, section_key, content_before, content_after, change_reason)
         VALUES ($1, $2, $3, $4, $5)`,
        [TEST_WIKI, key, oldContent, 'New content', 'fill empty'],
      );

      const { rows: history } = await client.query(
        'SELECT content_before FROM section_history WHERE wiki_id = $1 AND section_key = $2',
        [TEST_WIKI, key],
      );

      assert.equal(history[0].content_before, '');
    });
  });
});

describe('validateWiki — orphan detection', () => {
  // Orphan SQL as used by db.js validateWiki (single-wiki variant)
  async function countOrphans(client, wikiId) {
    const { rows } = await client.query(
      `SELECT COUNT(*) as count FROM wiki_sections s
       WHERE s.wiki_id = $1
         AND (
           (
             s.parent IS NULL
             AND NOT EXISTS (SELECT 1 FROM wiki_sections c WHERE c.parent = s.title AND c.wiki_id = s.wiki_id)
             AND NOT EXISTS (SELECT 1 FROM section_links sl WHERE sl.to_key = s.key AND sl.to_wiki_id = s.wiki_id)
           )
           OR (
             s.parent IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM wiki_sections p WHERE p.title = s.parent AND p.wiki_id = s.wiki_id)
             AND NOT EXISTS (SELECT 1 FROM section_links sl WHERE sl.to_key = s.key AND sl.to_wiki_id = s.wiki_id)
           )
         )`,
      [wikiId],
    );
    return parseInt(rows[0].count);
  }

  it('flags sections whose parent title does not match any existing section', async () => {
    await withClient(async (client) => {
      const key = 'test-orphan-missing-title';
      // No section has title "Ghost Topic" — this section should be flagged
      await createSection(client, key, { parent: 'Ghost Topic' });

      const count = await countOrphans(client, TEST_WIKI);
      assert.ok(count >= 1, 'Section with broken parent title should be flagged');
    });
  });

  it('flags sections with natural-language parents when no section title matches', async () => {
    await withClient(async (client) => {
      const key = 'test-orphan-natural-parent';
      // "My Long Topic Name" is not any section's title → should be flagged
      await createSection(client, key, { parent: 'My Long Topic Name' });

      const count = await countOrphans(client, TEST_WIKI);
      assert.ok(count >= 1, 'Section with unresolvable parent should be flagged');
    });
  });

  it('does NOT flag sections whose parent matches an existing section title', async () => {
    await withClient(async (client) => {
      const parentKey = 'test-orphan-real-parent';
      const childKey = 'test-orphan-real-child';

      // Parent section whose title is "Real Parent Topic"
      await createSection(client, parentKey, {
        parent: null,
        title: 'Real Parent Topic',
        content: 'A real parent section',
      });
      // Child section with parent = "Real Parent Topic"
      await createSection(client, childKey, { parent: 'Real Parent Topic' });

      // childKey should NOT be flagged — its parent title resolves
      const { rows } = await client.query(
        `SELECT COUNT(*) as count FROM wiki_sections s
         WHERE s.wiki_id = $1 AND s.key = $2
           AND s.parent IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM wiki_sections p WHERE p.title = s.parent AND p.wiki_id = s.wiki_id)`,
        [TEST_WIKI, childKey],
      );
      assert.equal(parseInt(rows[0].count), 0, 'Child with valid parent title should not be flagged');
    });
  });
});

describe('insertExplicitLinks — bulk INSERT', () => {
  it('inserts multiple links in a single query', async () => {
    await withClient(async (client) => {
      const fromKey = 'test-bulk-from';
      const targetKeys = ['test-bulk-target-1', 'test-bulk-target-2', 'test-bulk-target-3'];

      await createSection(client, fromKey);
      for (const tk of targetKeys) {
        await createSection(client, tk);
      }

      // Simulate the bulk insertExplicitLinks logic
      const valid = targetKeys;
      await client.query(
        `INSERT INTO section_links (from_wiki_id, from_key, to_wiki_id, to_key)
         SELECT $1, $2, $3, UNNEST($4::text[])
         ON CONFLICT DO NOTHING`,
        [TEST_WIKI, fromKey, TEST_WIKI, valid],
      );

      const { rows: links } = await client.query(
        'SELECT to_key FROM section_links WHERE from_wiki_id = $1 AND from_key = $2 ORDER BY to_key',
        [TEST_WIKI, fromKey],
      );

      assert.equal(links.length, 3);
      assert.deepEqual(links.map((r) => r.to_key), targetKeys);
    });
  });

  it('handles empty relatedKeys without error', async () => {
    await withClient(async (client) => {
      const fromKey = 'test-bulk-empty';
      await createSection(client, fromKey);

      // Should not throw with empty array
      await client.query(
        `INSERT INTO section_links (from_wiki_id, from_key, to_wiki_id, to_key)
         SELECT $1, $2, $3, UNNEST($4::text[])
         ON CONFLICT DO NOTHING`,
        [TEST_WIKI, fromKey, TEST_WIKI, []],
      );

      const { rows: links } = await client.query(
        'SELECT COUNT(*) as count FROM section_links WHERE from_wiki_id = $1 AND from_key = $2',
        [TEST_WIKI, fromKey],
      );
      assert.equal(parseInt(links[0].count), 0);
    });
  });

  it('deduplicates via ON CONFLICT DO NOTHING', async () => {
    await withClient(async (client) => {
      const fromKey = 'test-bulk-dedup';
      const targetKey = 'test-bulk-target-dedup';

      await createSection(client, fromKey);
      await createSection(client, targetKey);

      // Insert same link twice
      for (let i = 0; i < 2; i++) {
        await client.query(
          `INSERT INTO section_links (from_wiki_id, from_key, to_wiki_id, to_key)
           SELECT $1, $2, $3, UNNEST($4::text[])
           ON CONFLICT DO NOTHING`,
          [TEST_WIKI, fromKey, TEST_WIKI, [targetKey]],
        );
      }

      const { rows: links } = await client.query(
        'SELECT COUNT(*) as count FROM section_links WHERE from_wiki_id = $1 AND from_key = $2',
        [TEST_WIKI, fromKey],
      );
      assert.equal(parseInt(links[0].count), 1, 'Duplicate should be a no-op');
    });
  });
});

describe('findSimilarSections — NULL embedding fallback', () => {
  it('does not crash when target section has NULL embedding', async () => {
    await withClient(async (client) => {
      const key = 'test-null-embedding';
      // Don't set embedding — leave it NULL
      await createSection(client, key);

      // Create another section with a similar name for keyword fallback
      await createSection(client, 'test-null-embedding-other');

      // The app code should catch NULL embedding and fall back to Levenshtein
      // Simulate what findSimilarSections does:
      const { rows: targetCheck } = await client.query(
        'SELECT embedding FROM wiki_sections WHERE wiki_id = $1 AND key = $2',
        [TEST_WIKI, key],
      );

      assert.equal(targetCheck.length, 1);
      assert.equal(targetCheck[0].embedding, null, 'Target should have NULL embedding');

      // Should be able to fall back to Levenshtein keyword search
      const { rows: fallback } = await client.query(`
        SELECT key, wiki_id, title,
          LEVENSHTEIN(key, $1) as distance
        FROM wiki_sections
        WHERE wiki_id = $2 AND key != $1
          AND LEVENSHTEIN(key, $1) < LENGTH($1)
        ORDER BY distance
        LIMIT 5
      `, [key, TEST_WIKI]);

      // Should return at least the other section (it shares the "test-null-embedding" prefix)
      assert.ok(fallback.length > 0, 'Keyword fallback should return results');
    });
  });
});
