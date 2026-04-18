import { WikiParser } from '../src/utils.js';
import pkg from 'pg';
const { Pool } = pkg;
import { config } from 'dotenv';
import { logger } from '../logger.js';

config();

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5433'),
  user: process.env.DB_USER || 'wiki',
  password: process.env.DB_PASSWORD || 'wiki',
  database: process.env.DB_NAME || 'wiki',
});

// Parse WIKI_SOURCES env var (comma-separated paths)
// Each path maps to a wiki_id based on its basename
const WIKI_SOURCES = (process.env.WIKI_SOURCES || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
  .map(path => {
    const basename = path.split('/').filter(Boolean).pop();
    // Map common paths to wiki IDs
    const wikiIdMap = {
      'wiki': 'user-wiki',
      'docs': 'transact-wiki',
    };
    return {
      path,
      wikiId: wikiIdMap[basename] || basename.toLowerCase().replace(/[^a-z0-9]/g, '-'),
    };
  });

async function importWiki(source) {
  logger.info(`Starting import: ${source.path} → ${source.wikiId}`);

  const parser = new WikiParser(source.path);
  const keys = parser.getAllKeys();
  logger.info(`[${source.wikiId}] Found ${keys.length} sections`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let imported = 0;
    for (const key of keys) {
      const section = parser.getSection(key);
      if (!section) continue;

      const meta = parser.getMeta(key);

      await client.query(`
        INSERT INTO wiki_sections (wiki_id, key, parent, title, content, tags, status, metadata)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (wiki_id, key) DO UPDATE SET
          parent = EXCLUDED.parent,
          title = EXCLUDED.title,
          content = EXCLUDED.content,
          tags = EXCLUDED.tags,
          status = EXCLUDED.status,
          metadata = EXCLUDED.metadata,
          updated_at = NOW()
      `, [
        source.wikiId,
        key,
        section.parent === 'Root' ? null : section.parent,
        section.title,
        section.content,
        [],
        'active',
        JSON.stringify({
          breadcrumbs: section.breadcrumbs,
          depth: section.depth,
          file: section.file,
          fileSlug: section.fileSlug,
          filePath: section.filePath,
          legacyKey: section.legacyKey,
        }),
      ]);

      imported++;
    }

    await client.query('COMMIT');
    logger.info(`[${source.wikiId}] Imported ${imported} sections`);
    return imported;
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error(`[${source.wikiId}] Import failed`, { error: err.message });
    throw err;
  } finally {
    client.release();
  }
}

async function verify() {
  const { rows } = await pool.query(
    'SELECT wiki_id, COUNT(*) as count FROM wiki_sections GROUP BY wiki_id ORDER BY wiki_id'
  );
  return rows;
}

async function main() {
  if (WIKI_SOURCES.length === 0) {
    console.error('Error: WIKI_SOURCES env var not set. Example: WIKI_SOURCES=/ai/wiki,/home/dev/transAct/docs');
    process.exit(1);
  }

  console.log(`\nWiki V2 Import — ${WIKI_SOURCES.length} source(s)\n`);

  let totalImported = 0;
  for (const source of WIKI_SOURCES) {
    const count = await importWiki(source);
    totalImported += count;
  }

  console.log('\nVerification:');
  const stats = await verify();
  for (const row of stats) {
    console.log(`  ${row.wiki_id}: ${row.count} sections`);
  }

  const dbTotal = stats.reduce((sum, r) => sum + parseInt(r.count), 0);
  console.log(`\nTotal in DB: ${dbTotal} sections`);
  console.log(`Import complete: ${totalImported} sections processed\n`);

  await pool.end();
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
