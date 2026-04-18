import { WikiParser } from './utils.js';
import { pool } from './db.js';
import { getEmbedding } from './embedding.js';
import { logger } from '../logger.js';

/**
 * Map a source path to a wiki_id based on its basename.
 */
function pathToWikiId(sourcePath) {
  const basename = sourcePath.split('/').filter(Boolean).pop();
  const wikiIdMap = {
    wiki: 'user-wiki',
    docs: 'transact-wiki',
  };
  return wikiIdMap[basename] || basename.toLowerCase().replace(/[^a-z0-9]/g, '-');
}

/**
 * Import a single markdown file or directory into the wiki database.
 * @param {string} sourcePath - Path to a .md file or directory containing .md files
 * @param {string} [wikiId] - Wiki instance ID (auto-detected from path basename if not provided)
 * @returns {Promise<{ wikiId: string, imported: number, errors: string[] }>}
 */
export async function importWiki(sourcePath, wikiId = null) {
  const resolvedWikiId = wikiId || pathToWikiId(sourcePath);
  const errors = [];

  logger.info(`Starting import: ${sourcePath} → ${resolvedWikiId}`);

  const parser = new WikiParser(sourcePath);
  const keys = parser.getAllKeys();
  logger.info(`[${resolvedWikiId}] Found ${keys.length} sections`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let imported = 0;
    for (const key of keys) {
      try {
        const section = parser.getSection(key);
        if (!section) continue;

        const { rows: idRows } = await client.query(
          `
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
          RETURNING id
        `,
          [
            resolvedWikiId,
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
          ],
        );

        // Generate and store embedding
        if (idRows.length > 0) {
          try {
            const embedding = await getEmbedding(
              `${section.title}\n${section.content.slice(0, 2000)}`,
            );
            await client.query('UPDATE wiki_sections SET embedding = $1 WHERE id = $2', [
              JSON.stringify(embedding),
              idRows[0].id,
            ]);
          } catch (err) {
            logger.warn(`Failed to generate embedding for ${resolvedWikiId}/${key}`, {
              error: err.message,
            });
          }
        }

        imported++;
      } catch (err) {
        errors.push(`${key}: ${err.message}`);
        logger.error(`Import failed for ${resolvedWikiId}/${key}`, { error: err.message });
      }
    }

    await client.query('COMMIT');
    logger.info(`[${resolvedWikiId}] Imported ${imported} sections`);
    return { wikiId: resolvedWikiId, imported, errors };
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error(`[${resolvedWikiId}] Import failed`, { error: err.message });
    throw err;
  } finally {
    client.release();
  }
}
