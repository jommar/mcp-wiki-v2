import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';
import { logger } from '../logger.js';

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5433'),
  user: process.env.DB_USER || 'wiki',
  password: process.env.DB_PASSWORD || 'wiki',
  database: process.env.DB_NAME || 'wiki',
});

/**
 * Export wiki sections to a single markdown file.
 * @param {string} wikiId - Wiki instance ID
 * @param {string} outputDir - Directory to write the file to
 * @returns {Promise<{ wikiId: string, exported: number, filePath: string }>}
 */
export async function exportWiki(wikiId, outputDir) {
  const { rows: sections } = await pool.query(
    'SELECT key, parent, title, content FROM wiki_sections WHERE wiki_id = $1 ORDER BY parent, key',
    [wikiId],
  );

  if (sections.length === 0) {
    return { wikiId, exported: 0, filePath: null };
  }

  // Build one monolithic file, grouped by parent
  let content = '';
  let currentParent = null;
  let totalWritten = 0;

  for (const section of sections) {
    const parent = section.parent || 'Root';

    if (parent !== currentParent) {
      if (currentParent !== null) content += '\n';
      content += `# ${parent}\n\n`;
      currentParent = parent;
    }

    content += `## ${section.title} {#${section.key}}\n\n`;
    content += section.content + '\n\n';
    content += '---\n\n';
    totalWritten++;
  }

  fs.mkdirSync(outputDir, { recursive: true });
  const fileName = `${wikiId}.md`;
  const filePath = path.join(outputDir, fileName);
  fs.writeFileSync(filePath, content, 'utf8');
  logger.info(
    `[${wikiId}] Wrote ${fileName} (${totalWritten} sections, ${(content.length / 1024).toFixed(1)}KB)`,
  );

  return { wikiId, exported: totalWritten, filePath };
}

/**
 * Export all wikis to markdown files.
 * @param {string} outputDir - Directory to write files to
 * @returns {Promise<Array<{ wikiId: string, exported: number, filePath: string }>>}
 */
export async function exportAllWikis(outputDir) {
  const { rows: wikis } = await pool.query(
    'SELECT DISTINCT wiki_id FROM wiki_sections ORDER BY wiki_id',
  );

  const results = [];
  for (const { wiki_id } of wikis) {
    const result = await exportWiki(wiki_id, outputDir);
    results.push(result);
  }
  return results;
}

export { pool };
