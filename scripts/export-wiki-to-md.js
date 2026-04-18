import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';
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

async function exportWiki(wikiId, outputDir) {
  const { rows: sections } = await pool.query(
    'SELECT key, parent, title, content FROM wiki_sections WHERE wiki_id = $1 ORDER BY key',
    [wikiId]
  );

  if (sections.length === 0) {
    console.log(`[${wikiId}] No sections found`);
    return 0;
  }

  // Group by parent for organized output
  const byParent = {};
  for (const s of sections) {
    const parent = s.parent || 'Root';
    if (!byParent[parent]) byParent[parent] = [];
    byParent[parent].push(s);
  }

  // Write one file per parent group
  let totalWritten = 0;
  for (const [parent, group] of Object.entries(byParent)) {
    const safeParent = parent.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'root';
    const fileName = `${safeParent}.md`;
    const filePath = path.join(outputDir, fileName);

    let content = `# ${parent}\n\n`;
    for (const section of group) {
      content += `## ${section.title} {#${section.key}}\n\n`;
      content += section.content + '\n\n';
      content += '---\n\n';
      totalWritten++;
    }

    fs.writeFileSync(filePath, content, 'utf8');
    logger.info(`[${wikiId}] Wrote ${fileName} (${group.length} sections)`);
  }

  return totalWritten;
}

async function main() {
  const { wikiId, output } = parseArgs();

  // Create output directory
  fs.mkdirSync(output, { recursive: true });

  if (wikiId) {
    // Export single wiki
    const count = await exportWiki(wikiId, output);
    console.log(`\nExported ${count} sections from ${wikiId} → ${output}/`);
  } else {
    // Export all wikis
    const { rows: wikis } = await pool.query('SELECT DISTINCT wiki_id FROM wiki_sections ORDER BY wiki_id');
    for (const { wiki_id } of wikis) {
      const wikiDir = path.join(output, wiki_id);
      fs.mkdirSync(wikiDir, { recursive: true });
      const count = await exportWiki(wiki_id, wikiDir);
      console.log(`Exported ${count} sections from ${wiki_id} → ${wikiDir}/`);
    }
  }

  await pool.end();
  console.log('\nDone');
}

main().catch(err => {
  console.error('Export failed:', err);
  process.exit(1);
});
