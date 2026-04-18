import { config } from 'dotenv';
import { importWiki } from '../src/import.js';
import { pool } from '../src/db.js';

config();

// Parse WIKI_SOURCES env var (comma-separated paths)
const WIKI_SOURCES = (process.env.WIKI_SOURCES || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

async function main() {
  if (WIKI_SOURCES.length === 0) {
    console.error(
      'Error: WIKI_SOURCES env var not set. Example: WIKI_SOURCES=/ai/wiki,/home/dev/transAct/docs',
    );
    process.exit(1);
  }

  console.log(`\nWiki V2 Import — ${WIKI_SOURCES.length} source(s)\n`);

  let totalImported = 0;
  for (const sourcePath of WIKI_SOURCES) {
    const result = await importWiki(sourcePath);
    totalImported += result.imported;
    if (result.errors.length > 0) {
      console.log(`  Errors: ${result.errors.length}`);
    }
  }

  const { rows: stats } = await pool.query(
    'SELECT wiki_id, COUNT(*) as count FROM wiki_sections GROUP BY wiki_id ORDER BY wiki_id',
  );
  console.log('\nVerification:');
  for (const row of stats) {
    console.log(`  ${row.wiki_id}: ${row.count} sections`);
  }

  const dbTotal = stats.reduce((sum, r) => sum + parseInt(r.count), 0);
  console.log(`\nTotal in DB: ${dbTotal} sections`);
  console.log(`Import complete: ${totalImported} sections processed\n`);

  await pool.end();
}

main().catch((err) => {
  console.error('Import failed:', err);
  process.exit(1);
});
