import pkg from 'pg';
const { Pool } = pkg;
import { logger } from '../logger.js';

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5433'),
  user: process.env.DB_USER || 'wiki',
  password: process.env.DB_PASSWORD || 'wiki',
  database: process.env.DB_NAME || 'wiki',
});

/**
 * List all sections with optional wiki_id filter.
 */
export async function listSections(wikiId = null) {
  const query = wikiId
    ? 'SELECT key, parent, title, metadata, LENGTH(content) as content_length FROM wiki_sections WHERE wiki_id = $1 ORDER BY key'
    : 'SELECT key, wiki_id, parent, title, metadata, LENGTH(content) as content_length FROM wiki_sections ORDER BY wiki_id, key';
  const { rows } = await pool.query(query, wikiId ? [wikiId] : []);
  return rows.map(r => ({
    key: r.key,
    wikiId: r.wiki_id,
    parent: r.parent || 'Root',
    title: r.title,
    breadcrumbs: r.metadata?.breadcrumbs || [],
    contentLength: r.content_length,
  }));
}

/**
 * Browse sections by parent topic.
 */
export async function browseSections(topic, wikiId = null) {
  let query = `
    SELECT key, wiki_id, parent, title, metadata->>'depth' as depth, metadata->'breadcrumbs' as breadcrumbs
    FROM wiki_sections
  `;
  const params = [];
  const conditions = [];

  if (topic) {
    conditions.push(`(
      LOWER(parent) LIKE $${params.length + 1}
      OR LOWER(title) LIKE $${params.length + 1}
      OR metadata->>'breadcrumbs' ILIKE $${params.length + 1}
    )`);
    params.push(`%${topic.toLowerCase()}%`);
  }
  if (wikiId) {
    conditions.push(`wiki_id = $${params.length + 1}`);
    params.push(wikiId);
  }
  if (conditions.length) {
    query += ' WHERE ' + conditions.join(' AND ');
  }
  query += ' ORDER BY parent, key';

  const { rows } = await pool.query(query, params);
  return rows.map(r => ({
    key: r.key,
    wikiId: r.wiki_id,
    parent: r.parent || 'Root',
    title: r.title,
    depth: parseInt(r.depth) || 2,
    breadcrumbs: r.breadcrumbs || [],
  }));
}

/**
 * Search sections using full-text search (tsvector).
 */
export async function searchSections(query, { wikiId = null, fuzzy = false, limit = 20 } = {}) {
  if (fuzzy) {
    // Fall back to trigram similarity for fuzzy matching
    return searchFuzzy(query, { wikiId, limit });
  }

  const params = [];
  let whereClause = '';

  if (wikiId) {
    whereClause = `WHERE wiki_id = $${params.length + 1}`;
    params.push(wikiId);
  }

  // Build tsquery from user input
  const searchTerms = query.toLowerCase().split(/\s+/).filter(Boolean).map(t => t + ':*').join(' & ');

  const searchQuery = `
    SELECT key, wiki_id, parent, title, metadata->'breadcrumbs' as breadcrumbs,
           ts_rank(search_vector, to_tsquery('english', $${params.length + 1})) as rank,
           LENGTH(content) as content_length
    FROM wiki_sections
    ${whereClause} ${whereClause ? 'AND' : 'WHERE'} search_vector @@ to_tsquery('english', $${params.length + 1})
    ORDER BY rank DESC
    LIMIT $${params.length + 2}
  `;
  params.push(searchTerms, limit);

  const { rows } = await pool.query(searchQuery, params);
  return rows.map(r => ({
    key: r.key,
    wikiId: r.wiki_id,
    parent: r.parent || 'Root',
    title: r.title,
    breadcrumbs: r.breadcrumbs || [],
    rank: r.rank,
    contentLength: r.content_length,
  }));
}

/**
 * Fuzzy search using trigram similarity.
 */
async function searchFuzzy(query, { wikiId, limit }) {
  const params = [];
  let whereClause = '';

  if (wikiId) {
    whereClause = `WHERE wiki_id = $${params.length + 1}`;
    params.push(wikiId);
  }

  const searchQuery = `
    SELECT key, wiki_id, parent, title, metadata->'breadcrumbs' as breadcrumbs,
           GREATEST(
             similarity(title, $${params.length + 1}),
             similarity(key, $${params.length + 1})
           ) as score,
           LENGTH(content) as content_length
    FROM wiki_sections
    ${whereClause} ${whereClause ? 'AND' : 'WHERE'} (
      title % $${params.length + 1}
      OR key % $${params.length + 1}
      OR content ILIKE $${params.length + 1}
    )
    ORDER BY score DESC
    LIMIT $${params.length + 2}
  `;
  params.push(query, limit);

  const { rows } = await pool.query(searchQuery, params);
  return rows.map(r => ({
    key: r.key,
    wikiId: r.wiki_id,
    parent: r.parent || 'Root',
    title: r.title,
    breadcrumbs: r.breadcrumbs || [],
    rank: r.score,
    contentLength: r.content_length,
  }));
}

/**
 * Get a single section by key with pagination.
 */
export async function getSection(key, { wikiId = null, offset = 0, limit = 8000 } = {}) {
  const params = [key];
  let whereClause = 'WHERE s.key = $1';

  if (wikiId) {
    whereClause += ' AND s.wiki_id = $2';
    params.push(wikiId);
  }

  const query = `
    SELECT key, wiki_id, parent, title, metadata,
           content,
           LENGTH(content) as total_length
    FROM wiki_sections s
    ${whereClause}
  `;

  const { rows } = await pool.query(query, params);
  if (rows.length === 0) return null;

  const row = rows[0];
  const totalLength = row.total_length;
  const content = row.content.slice(offset, offset + limit);
  const hasMore = offset + limit < totalLength;

  return {
    key: row.key,
    wikiId: row.wiki_id,
    parent: row.parent || 'Root',
    title: row.title,
    breadcrumbs: row.metadata?.breadcrumbs || [],
    source: row.metadata?.filePath || '',
    content,
    totalLength,
    offset,
    limit,
    hasMore,
    nextOffset: hasMore ? offset + limit : undefined,
  };
}

/**
 * Get multiple sections at once.
 */
export async function getSections(keys, { wikiId = null, truncateLimit = 8000 } = {}) {
  if (keys.length === 0) return [];

  const params = [keys];
  let whereClause = 'WHERE key = ANY($1)';
  if (wikiId) {
    whereClause += ' AND wiki_id = $2';
    params.push(wikiId);
  }

  const query = `
    SELECT key, wiki_id, parent, title, metadata, content, LENGTH(content) as total_length
    FROM wiki_sections
    ${whereClause}
    ORDER BY array_position($1, key)
  `;

  const { rows } = await pool.query(query, params);
  return rows.map(r => {
    const truncated = r.total_length > truncateLimit;
    return {
      key: r.key,
      wikiId: r.wiki_id,
      parent: r.parent || 'Root',
      title: r.title,
      breadcrumbs: r.metadata?.breadcrumbs || [],
      source: r.metadata?.filePath || '',
      content: truncated ? r.content.slice(0, truncateLimit) : r.content,
      truncated,
      totalLength: truncated ? r.total_length : undefined,
    };
  });
}

/**
 * Get wiki info (section count, etc).
 */
export async function getWikiInfo(wikiId = null) {
  if (wikiId) {
    const { rows } = await pool.query(
      'SELECT COUNT(*) as section_count FROM wiki_sections WHERE wiki_id = $1',
      [wikiId]
    );
    return { wikiId, sectionCount: parseInt(rows[0].section_count) };
  }

  const { rows } = await pool.query(
    'SELECT wiki_id, COUNT(*) as section_count FROM wiki_sections GROUP BY wiki_id ORDER BY wiki_id'
  );
  return rows.map(r => ({
    wikiId: r.wiki_id,
    sectionCount: parseInt(r.section_count),
  }));
}

/**
 * Get backlinks for a section (what other sections link to it).
 */
export async function getBacklinks(key, wikiId = null) {
  const params = [key];
  let whereClause = 'WHERE sl.to_key = $1';
  if (wikiId) {
    whereClause += ' AND sl.to_wiki_id = $2';
    params.push(wikiId);
  }

  const query = `
    SELECT sl.from_key, sl.from_wiki_id, ws.title as from_title, ws.parent as from_parent
    FROM section_links sl
    JOIN wiki_sections ws ON ws.wiki_id = sl.from_wiki_id AND ws.key = sl.from_key
    ${whereClause}
    ORDER BY ws.title
  `;

  const { rows } = await pool.query(query, params);
  return rows.map(r => ({
    key: r.from_key,
    wikiId: r.from_wiki_id,
    title: r.from_title,
    parent: r.from_parent || 'Root',
  }));
}

/**
 * Validate wiki health (empty sections, orphans, etc).
 */
export async function validateWiki(wikiId = null) {
  const params = [];
  let whereClause = '';
  if (wikiId) {
    whereClause = `WHERE wiki_id = $1`;
    params.push(wikiId);
  }

  const results = {};

  // Empty sections
  const { rows: empty } = await pool.query(`
    SELECT key, title FROM wiki_sections
    ${whereClause} ${whereClause ? 'AND' : 'WHERE'} content = '' OR content IS NULL
  `, params);
  results.emptySections = empty.map(r => ({ key: r.key, title: r.title }));

  // Orphaned sections (no parent, no children, no backlinks)
  const { rows: orphans } = await pool.query(`
    SELECT s.key, s.title, s.parent
    FROM wiki_sections s
    ${whereClause} ${whereClause ? 'AND' : 'WHERE'} (
      s.parent IS NULL
      AND NOT EXISTS (SELECT 1 FROM wiki_sections c WHERE c.parent = s.title AND c.wiki_id = s.wiki_id)
      AND NOT EXISTS (SELECT 1 FROM section_links sl WHERE sl.to_key = s.key AND sl.to_wiki_id = s.wiki_id)
    )
  `, params);
  results.orphanedSections = orphans.map(r => ({ key: r.key, title: r.title }));

  // Sections with no backlinks (not linked from anywhere)
  const { rows: unlinked } = await pool.query(`
    SELECT s.key, s.title
    FROM wiki_sections s
    ${whereClause} ${whereClause ? 'AND' : 'WHERE'} NOT EXISTS (
      SELECT 1 FROM section_links sl WHERE sl.to_key = s.key AND sl.to_wiki_id = s.wiki_id
    )
    AND s.parent IS NOT NULL
  `, params);
  results.unlinkedSections = unlinked.map(r => ({ key: r.key, title: r.title }));

  return results;
}

/**
 * Create a new section.
 */
export async function createSection({ wikiId, key, title, content, parent = null, tags = [] }) {
  // Check for existing section first to give a clear error
  const { rows: existing } = await pool.query(
    'SELECT key FROM wiki_sections WHERE wiki_id = $1 AND key = $2',
    [wikiId, key]
  );
  if (existing.length > 0) {
    return { exists: true };
  }

  const { rows } = await pool.query(`
    INSERT INTO wiki_sections (wiki_id, key, parent, title, content, tags, status, metadata)
    VALUES ($1, $2, $3, $4, $5, $6::varchar(100)[], 'active', $7)
    RETURNING key, wiki_id, title, parent
  `, [wikiId, key, parent, title, content, tags, JSON.stringify({ breadcrumbs: [] })]);

  return rows[0] || null;
}

/**
 * Update an existing section.
 */
export async function updateSection({ wikiId, key, content, title, parent, tags, reason }) {
  // Check existence first
  const { rows: existing } = await pool.query(
    'SELECT key, title FROM wiki_sections WHERE wiki_id = $1 AND key = $2',
    [wikiId, key]
  );
  if (existing.length === 0) {
    return { notFound: true };
  }

  const updates = [];
  const params = [];
  let paramIdx = 1;

  if (content !== undefined) { updates.push(`content = $${paramIdx++}`); params.push(content); }
  if (title !== undefined) { updates.push(`title = $${paramIdx++}`); params.push(title); }
  if (parent !== undefined) { updates.push(`parent = $${paramIdx++}`); params.push(parent || null); }
  if (tags !== undefined) { updates.push(`tags = $${paramIdx++}::varchar(100)[]`); params.push(tags); }

  if (updates.length === 0) return { noChanges: true };

  updates.push('updated_at = NOW()');
  params.push(wikiId, key);

  const { rows } = await pool.query(`
    UPDATE wiki_sections SET ${updates.join(', ')}
    WHERE wiki_id = $${paramIdx} AND key = $${paramIdx + 1}
    RETURNING key, wiki_id, title, parent
  `, params);

  // Log history if content changed
  if (content !== undefined && rows.length > 0) {
    await pool.query(`
      INSERT INTO section_history (wiki_id, section_key, content_after, change_reason)
      VALUES ($1, $2, $3, $4)
    `, [wikiId, key, content, reason || 'update']);
  }

  return rows[0] || null;
}

/**
 * Delete a section.
 */
export async function deleteSection(wikiId, key) {
  const { rows } = await pool.query(`
    DELETE FROM wiki_sections WHERE wiki_id = $1 AND key = $2
    RETURNING key, wiki_id, title
  `, [wikiId, key]);

  // Also delete backlinks
  await pool.query(
    'DELETE FROM section_links WHERE (from_wiki_id = $1 AND from_key = $2) OR (to_wiki_id = $1 AND to_key = $2)',
    [wikiId, key]
  );

  return rows[0] || null;
}

/**
 * Get section history.
 */
export async function getSectionHistory(wikiId, key, limit = 10) {
  const { rows } = await pool.query(`
    SELECT content_before, content_after, changed_at, change_reason
    FROM section_history
    WHERE wiki_id = $1 AND section_key = $2
    ORDER BY changed_at DESC
    LIMIT $3
  `, [wikiId, key, limit]);

  return rows;
}

/**
 * Find similar keys (for "did you mean" suggestions).
 */
export async function findSimilar(query, wikiId = null, maxResults = 5) {
  const params = [];
  let whereClause = '';
  if (wikiId) {
    whereClause = `WHERE wiki_id = $${params.length + 1}`;
    params.push(wikiId);
  }

  const { rows } = await pool.query(`
    SELECT key, wiki_id, title,
      LEVENSHTEIN(key, $${params.length + 1}) as distance
    FROM wiki_sections
    ${whereClause} ${whereClause ? 'AND' : 'WHERE'} LEVENSHTEIN(key, $${params.length + 1}) < LENGTH($${params.length + 1})
    ORDER BY distance
    LIMIT $${params.length + 2}
  `, [...params, query, maxResults]);

  return rows.map(r => ({ key: r.key, wikiId: r.wiki_id, title: r.title, distance: r.distance }));
}

export { pool };
