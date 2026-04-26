import fs from 'fs';
import path from 'path';
import pkg from 'pg';
import { pool as defaultPool } from './db.js';
import { logger } from '../logger.js';

const { Query } = pkg;

/**
 * Drain-aware write: returns a promise that resolves when the chunk is flushed.
 * If the stream signals backpressure (write returns false), waits for 'drain'.
 */
function writeWhenReady(stream, chunk) {
  if (stream.write(chunk)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    stream.once('drain', resolve);
    stream.once('error', reject);
  });
}

/**
 * Serialize a value for YAML frontmatter (simple, no external deps).
 */
export function yamlValue(value) {
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
export function buildFrontmatter(section) {
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
 * Export a single wiki to a markdown file using streaming reads.
 * Each section includes YAML frontmatter with key, parent, title, and tags.
 * Uses a pg Query with row events to avoid loading all rows into memory.
 * @param {string} wikiId - Wiki instance ID
 * @param {string} outputDir - Directory to write the file to
 * @returns {Promise<{ wikiId: string, exported: number, filePath: string | null }>}
 */
export async function exportWiki(wikiId, outputDir, { pool: customPool } = {}) {
  const activePool = customPool || defaultPool;
  const client = await activePool.connect();
  try {
    const fileName = `${wikiId}.md`;
    const filePath = path.join(outputDir, fileName);
    const tmpPath = filePath + '.tmp';

    fs.mkdirSync(outputDir, { recursive: true });
    const writeStream = fs.createWriteStream(tmpPath, 'utf8');

    const query = new Query(
      'SELECT key, parent, title, content, tags FROM wiki_sections WHERE wiki_id = $1 ORDER BY parent, key',
      [wikiId],
    );

    client.query(query);

    let currentParent = null;
    let exportedCount = 0;
    let writeChain = Promise.resolve();

    await new Promise((resolve, reject) => {
      query.on('row', (row) => {
        exportedCount++;
        const parent = row.parent || 'Root';

        let chunk = '';
        if (parent !== currentParent) {
          if (currentParent !== null) chunk += '\n';
          chunk += `# ${parent}\n\n`;
          currentParent = parent;
        }
        chunk += buildFrontmatter(row) + '\n\n';
        chunk += row.content + '\n\n';
        chunk += '---\n\n';

        writeChain = writeChain.then(() => writeWhenReady(writeStream, chunk));
      });

      query.on('error', reject);

      query.on('end', () => {
        writeChain.then(resolve).catch(reject);
      });
    });

    // Finalize the write stream
    await new Promise((resolve, reject) => {
      writeStream.on('error', reject);
      writeStream.end(resolve);
    });

    // Handle empty wiki — clean up temp file
    if (exportedCount === 0) {
      fs.unlinkSync(tmpPath);
      return { wikiId, exported: 0, filePath: null };
    }

    // Atomic rename
    fs.renameSync(tmpPath, filePath);

    logger.info(`[${wikiId}] Exported ${exportedCount} sections → ${fileName}`);
    return { wikiId, exported: exportedCount, filePath };
  } finally {
    client.release();
  }
}

/**
 * Export all wikis to markdown files.
 * @param {string} outputDir - Directory to write files to
 * @returns {Promise<Array<{ wikiId: string, exported: number, filePath: string }>>}
 */
export async function exportAllWikis(outputDir, { pool: customPool } = {}) {
  const activePool = customPool || defaultPool;
  const { rows: wikis } = await activePool.query(
    'SELECT DISTINCT wiki_id FROM wiki_sections ORDER BY wiki_id',
  );

  const results = [];
  for (const { wiki_id } of wikis) {
    const result = await exportWiki(wiki_id, outputDir, { pool: activePool });
    if (result.exported > 0) results.push(result);
  }
  return results;
}
