import fs from 'fs';
import path from 'path';
import { pool } from './db.js';
import { logger } from '../logger.js';

/**
 * Serialize a value for YAML frontmatter (simple, no external deps).
 */
function yamlValue(value) {
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return `[${value.map((v) => `"${v}"`).join(', ')}]`;
  }
  if (typeof value === 'string') {
    if (value.includes(':') || value.includes('#') || value.includes('"')) {
      return `"${value.replace(/"/g, '\\"')}"`;
    }
    return value;
  }
  return String(value);
}

/**
 * Build YAML frontmatter for a section.
 */
function buildFrontmatter(section) {
  const lines = ['---'];
  lines.push(`key: ${yamlValue(section.key)}`);
  lines.push(`parent: ${yamlValue(section.parent || 'Root')}`);
  lines.push(`title: ${yamlValue(section.title)}`);
  if (section.tags && section.tags.length > 0) {
    lines.push(`tags: ${yamlValue(section.tags)}`);
  }
  lines.push('---');
  return lines.join('\n');
}

/**
 * Export a single wiki to a markdown file.
 * Each section includes YAML frontmatter with key, parent, title, and tags.
 * @param {string} wikiId - Wiki instance ID
 * @param {string} outputDir - Directory to write the file to
 * @returns {Promise<{ wikiId: string, exported: number, filePath: string | null }>}
 */
export async function exportWiki(wikiId, outputDir) {
  const { rows: sections } = await pool.query(
    'SELECT key, parent, title, content, tags FROM wiki_sections WHERE wiki_id = $1 ORDER BY parent, key',
    [wikiId],
  );

  if (sections.length === 0) {
    return { wikiId, exported: 0, filePath: null };
  }

  let content = '';
  let currentParent = null;

  for (const section of sections) {
    const parent = section.parent || 'Root';

    if (parent !== currentParent) {
      if (currentParent !== null) content += '\n';
      content += `# ${parent}\n\n`;
      currentParent = parent;
    }

    content += buildFrontmatter(section) + '\n\n';
    content += section.content + '\n\n';
    content += '---\n\n';
  }

  fs.mkdirSync(outputDir, { recursive: true });
  const fileName = `${wikiId}.md`;
  const filePath = path.join(outputDir, fileName);
  const tmpPath = filePath + '.tmp';

  // Atomic write: write to temp file, then rename
  fs.writeFileSync(tmpPath, content, 'utf8');
  fs.renameSync(tmpPath, filePath);

  logger.info(`[${wikiId}] Exported ${sections.length} sections → ${fileName}`);
  return { wikiId, exported: sections.length, filePath };
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
    if (result.exported > 0) results.push(result);
  }
  return results;
}
