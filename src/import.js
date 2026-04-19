import fs from 'fs';
import path from 'path';
import { pool } from './db.js';
import { getEmbedding } from './embedding.js';
import { logger } from '../logger.js';

const STAGING_DIR = path.resolve('import/staging');
const SUCCESS_DIR = path.resolve('import/success');
const FAIL_DIR = path.resolve('import/fail');

const KEY_PATTERN = /^[a-z0-9-]+$/;
const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown']);

/**
 * Parse all sections from a multi-section markdown file.
 * Each section has its own YAML frontmatter block delimited by ---.
 * Returns array of { frontmatter, body } or null if no sections found.
 */
function parseAllSections(content) {
  const sections = [];
  // Match frontmatter blocks: ---\nkey: ...\n...\n---
  const regex = /---\n([\s\S]*?)\n---/g;
  let match;
  const blocks = [];

  while ((match = regex.exec(content)) !== null) {
    const raw = match[1];
    const frontmatter = {};

    for (const line of raw.split('\n')) {
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;
      const key = line.slice(0, colonIdx).trim();
      let value = line.slice(colonIdx + 1).trim();

      // Parse arrays: [a, b, c] or ["a", "b"]
      if (value.startsWith('[') && value.endsWith(']')) {
        const inner = value.slice(1, -1).trim();
        if (inner === '') {
          value = [];
        } else {
          value = inner.split(',').map((s) => s.trim().replace(/^"|"$/g, ''));
        }
      }
      // Unquote strings
      else if (value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1);
      }

      frontmatter[key] = value;
    }

    // Only consider blocks that have a 'key' field as section frontmatter
    if (frontmatter.key) {
      blocks.push({ index: match.index, end: match.index + match[0].length, frontmatter });
    }
  }

  // Extract body for each section (content between this block's end and next block's start)
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const nextStart = i + 1 < blocks.length ? blocks[i + 1].index : content.length;
    let body = content.slice(block.end, nextStart).trim();

    // Remove trailing --- separator if present
    body = body.replace(/\n?---\s*$/, '').trim();

    sections.push({ frontmatter: block.frontmatter, body });
  }

  return sections.length > 0 ? sections : null;
}

/**
 * Validate frontmatter fields. Returns error string or null.
 */
function validateFrontmatter(fm) {
  if (!fm.key) return 'Missing required field: key';
  if (!fm.parent) return 'Missing required field: parent';
  if (!fm.title) return 'Missing required field: title';
  if (!KEY_PATTERN.test(fm.key)) return `Invalid key format: "${fm.key}". Must be lowercase alphanumeric with hyphens`;
  return null;
}

/**
 * Move a file from one path to another, creating directories as needed.
 */
function moveFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
}

/**
 * Import a single markdown file (single or multi-section) into the database.
 * All sections from one file are imported within a single transaction.
 * Generates embeddings inline. Rolls back on any failure.
 * @param {string} filePath - Path to the .md file
 * @returns {Promise<{ wikiId: string, sections: number, imported: boolean, error?: string }>}
 */
async function importFile(filePath) {
  const fileName = path.basename(filePath);
  const content = fs.readFileSync(filePath, 'utf8');

  // Derive wiki_id from filename (without extension)
  const wikiId = path.parse(fileName).name.toLowerCase().replace(/[^a-z0-9]/g, '-');

  const sections = parseAllSections(content);
  if (!sections) {
    return { wikiId, sections: 0, imported: false, error: 'No valid frontmatter sections found' };
  }

  // Validate all sections first before starting transaction
  for (const section of sections) {
    const validationError = validateFrontmatter(section.frontmatter);
    if (validationError) {
      return { wikiId, sections: 0, imported: false, error: `${validationError} (key: ${section.frontmatter.key || 'unknown'})` };
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let imported = 0;
    for (const section of sections) {
      const { frontmatter, body } = section;
      const key = frontmatter.key;
      const parent = frontmatter.parent;
      const title = frontmatter.title;
      const tags = frontmatter.tags || [];

      // Upsert the section
      const { rows } = await client.query(
        `
        INSERT INTO wiki_sections (wiki_id, key, parent, title, content, tags, status, metadata)
        VALUES ($1, $2, $3, $4, $5, $6::varchar(100)[], 'active', $7)
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
        [wikiId, key, parent, title, body, tags, JSON.stringify({})],
      );

      if (rows.length === 0) {
        await client.query('ROLLBACK');
        return { wikiId, sections: 0, imported: false, error: `Upsert failed for key: ${key}` };
      }

      const sectionId = rows[0].id;

      // Generate and store embedding
      try {
        const embedding = await getEmbedding(`${title}\n${body.slice(0, 2000)}`);
        await client.query('UPDATE wiki_sections SET embedding = $1 WHERE id = $2', [
          JSON.stringify(embedding),
          sectionId,
        ]);
      } catch (err) {
        logger.warn(`Failed to generate embedding for ${wikiId}/${key}`, { error: err.message });
        // Don't fail the import for embedding errors
      }

      imported++;
    }

    await client.query('COMMIT');
    return { wikiId, sections: imported, imported: true };
  } catch (err) {
    await client.query('ROLLBACK');
    return { wikiId, sections: 0, imported: false, error: err.message };
  } finally {
    client.release();
  }
}

/**
 * Process all .md files in the staging directory.
 * Successful files move to success/, failed files move to fail/.
 * @returns {Promise<{ total: number, success: number, failed: number, errors: Array<{ file: string, error: string }> }>}
 */
export async function processStaging() {
  // Ensure directories exist
  fs.mkdirSync(STAGING_DIR, { recursive: true });
  fs.mkdirSync(SUCCESS_DIR, { recursive: true });
  fs.mkdirSync(FAIL_DIR, { recursive: true });

  const files = fs
    .readdirSync(STAGING_DIR)
    .filter((f) => MARKDOWN_EXTENSIONS.has(path.extname(f).toLowerCase()))
    .sort();

  if (files.length === 0) {
    logger.info('No files in staging directory');
    return { total: 0, success: 0, failed: 0, errors: [] };
  }

  logger.info(`Processing ${files.length} file(s) from staging`);

  let success = 0;
  let failed = 0;
  const errors = [];

  for (const file of files) {
    const filePath = path.join(STAGING_DIR, file);

    try {
      const result = await importFile(filePath);

      if (result.imported) {
        moveFile(filePath, path.join(SUCCESS_DIR, file));
        success++;
        logger.info(`Imported: ${file} → ${result.wikiId} (${result.sections} sections)`);
      } else {
        moveFile(filePath, path.join(FAIL_DIR, file));
        failed++;
        errors.push({ file, error: result.error });
        logger.warn(`Failed: ${file} — ${result.error}`);
      }
    } catch (err) {
      moveFile(filePath, path.join(FAIL_DIR, file));
      failed++;
      errors.push({ file, error: err.message });
      logger.error(`Failed: ${file} — ${err.message}`);
    }
  }

  logger.info(`Import complete: ${success} succeeded, ${failed} failed`);
  return { total: files.length, success, failed, errors };
}
