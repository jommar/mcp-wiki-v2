import { config } from 'dotenv';
import { processStaging } from '../src/import.js';
import { autoLinkSections } from '../src/service.js';
import { pool } from '../src/db.js';

config();

async function main() {
  console.log('\nWiki V2 Import — Processing staging directory\n');

  const result = await processStaging();

  console.log(`Total:   ${result.total}`);
  console.log(`Success: ${result.success}`);
  console.log(`Failed:  ${result.failed}`);

  if (result.errors.length > 0) {
    console.log('\nErrors:');
    for (const { file, error } of result.errors) {
      console.log(`  ${file}: ${error}`);
    }
  }

  if (result.success > 0) {
    console.log('\nRunning auto-link for all wikis...');
    await autoLinkSections(null);
    console.log('Auto-link complete.');
  }

  // Show DB stats
  const { rows: stats } = await pool.query(
    'SELECT wiki_id, COUNT(*) as count FROM wiki_sections GROUP BY wiki_id ORDER BY wiki_id',
  );
  console.log('\nWiki stats:');
  for (const row of stats) {
    console.log(`  ${row.wiki_id}: ${row.count} sections`);
  }

  console.log('\nDone\n');
  await pool.end();
}

main().catch((err) => {
  console.error('Import failed:', err);
  process.exit(1);
});
