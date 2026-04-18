import { config } from 'dotenv';
import { exportWiki, exportAllWikis } from '../src/export.js';
import { logger } from '../logger.js';

config();

/**
 * Export wiki sections to markdown files.
 *
 * Usage:
 *   node scripts/export-wiki-to-md.js                    # export all wikis to ./export/
 *   node scripts/export-wiki-to-md.js --wiki user-wiki   # export only user-wiki
 *   node scripts/export-wiki-to-md.js --output /tmp/wiki # custom output dir
 */
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { wikiId: null, output: './export' };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--wiki' && args[i + 1]) { opts.wikiId = args[++i]; }
    if (args[i] === '--output' && args[i + 1]) { opts.output = args[++i]; }
  }

  return opts;
}

async function main() {
  const { wikiId, output } = parseArgs();

  if (wikiId) {
    const result = await exportWiki(wikiId, output);
    console.log(`\nExported ${result.exported} sections from ${wikiId} → ${result.filePath}`);
  } else {
    const results = await exportAllWikis(output);
    for (const r of results) {
      console.log(`Exported ${r.exported} sections from ${r.wikiId} → ${r.filePath}`);
    }
  }

  console.log('\nDone');
}

main().catch(err => {
  console.error('Export failed:', err);
  process.exit(1);
});
