import { config } from 'dotenv';
import { autoLinkSections } from '../src/service.js';
import { pool } from '../src/db.js';

config();

// Parse CLI args
const args = process.argv.slice(2);
const reembed = args.includes('--reembed');
const help = args.includes('--help');

if (help) {
  console.log(`
Wiki V2 — Re-link All Sections

Usage: node relink-all-sections.js [options]

Options:
  --reembed   Regenerate embeddings before linking (slower, default: false)
  --help      Show this help message
`);
  process.exit(0);
}

async function main() {
  console.log('\nWiki V2 — Re-link All Sections (Override Mode)\n');
  console.log(`Options: reembed=${reembed}\n`);

  // Get all wiki IDs
  const { rows: wikis } = await pool.query('SELECT DISTINCT wiki_id FROM wiki_sections');
  const wikiIds = wikis.map((r) => r.wiki_id);

  if (wikiIds.length === 0) {
    console.log('No wikis found.');
    return;
  }

  console.log(`Found wikis: ${wikiIds.join(', ')}\n`);

  for (const wikiId of wikiIds) {
    console.log(`Processing ${wikiId}...`);
    await autoLinkSections(wikiId, { override: true, parallel: true, reembed });
    console.log(`  → complete`);
  }

  console.log('\nAll done.');
  await pool.end();
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
