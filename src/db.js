import pkg from 'pg';
const { Pool } = pkg;
import { logger } from '../logger.js';
import { getEmbedding } from './embedding.js';

// Constants for auto-linking and access tracking
const MAX_ACCESS_COUNT = 9999;
const MAX_LINKS_PER_SECTION = 4;

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5433'),
  user: process.env.DB_USER || 'wiki',
  password: process.env.DB_PASSWORD || 'wiki',
  database: process.env.DB_NAME || 'wiki',
});

// Enable required extensions
pool.query('CREATE EXTENSION IF NOT EXISTS fuzzystrmatch').catch(() => {
  // Ignore - extension may already exist or require superuser
});

/**
 * List all sections with optional wiki_id filter.
 */
export async function listSections(wikiId = null, limit = 100) {
  const query = wikiId
    ? 'SELECT key, wiki_id, parent, title, metadata, LENGTH(content) as content_length FROM wiki_sections WHERE wiki_id = $1 ORDER BY key LIMIT $2'
    : 'SELECT key, wiki_id, parent, title, metadata, LENGTH(content) as content_length FROM wiki_sections ORDER BY wiki_id, key LIMIT $1';
  const { rows } = await pool.query(query, wikiId ? [wikiId, limit] : [limit]);
  return rows.map((r) => ({
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
export async function browseSections(topic, wikiId = null, limit = 100) {
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
  query += ' ORDER BY parent, key LIMIT $' + (params.length + 1);
  params.push(limit);

  const { rows } = await pool.query(query, params);
  return rows.map((r) => ({
    key: r.key,
    wikiId: r.wiki_id,
    parent: r.parent || 'Root',
    title: r.title,
    depth: parseInt(r.depth) || 2,
    breadcrumbs: r.breadcrumbs || [],
  }));
}

/**
 * Semantic search using vector embeddings (cosine distance).
 */
async function searchSemantic(query, { wikiId, limit }) {
  try {
    const embedding = await getEmbedding(query);
    const params = [JSON.stringify(embedding)];
    let whereClause = '';
    if (wikiId) {
      whereClause = `WHERE wiki_id = $2`;
      params.push(wikiId);
    }

    const searchQuery = `
      SELECT key, wiki_id, parent, title, metadata->'breadcrumbs' as breadcrumbs,
             1 - (embedding <=> $1) as similarity,
             LENGTH(content) as content_length
      FROM wiki_sections
      ${whereClause} ${whereClause ? 'AND' : 'WHERE'} embedding IS NOT NULL
      ORDER BY embedding <=> $1
      LIMIT $${params.length + 1}
    `;
    params.push(limit);

    const { rows } = await pool.query(searchQuery, params);
    return rows.map((r) => ({
      key: r.key,
      wikiId: r.wiki_id,
      parent: r.parent || 'Root',
      title: r.title,
      breadcrumbs: r.breadcrumbs || [],
      rank: r.similarity,
      contentLength: r.content_length,
    }));
  } catch (err) {
    logger.warn('Semantic search failed, falling back to keyword', { error: err.message });
    return [];
  }
}

/**
 * Search sections using full-text search (tsvector).
 * Tries semantic search first; falls back to keyword if no embeddings exist.
 */
export async function searchSections(query, { wikiId = null, fuzzy = false, limit = 20 } = {}) {
  if (fuzzy) {
    // Fall back to trigram similarity for fuzzy matching
    return searchFuzzy(query, { wikiId, limit });
  }

  // Try semantic search first
  const semanticResults = await searchSemantic(query, { wikiId, limit });

  // If we got results with meaningful similarity, use them
  if (semanticResults.length > 0 && semanticResults.some((r) => r.rank > 0.1)) {
    return semanticResults;
  }

  // Fall back to keyword search
  const params = [];
  let whereClause = '';

  if (wikiId) {
    whereClause = `WHERE wiki_id = $${params.length + 1}`;
    params.push(wikiId);
  }

  // Build tsquery from user input
  const searchTerms = query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => t + ':*')
    .join(' & ');

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
  return rows.map((r) => ({
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
  return rows.map((r) => ({
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
  return rows.map((r) => {
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
      [wikiId],
    );
    return { wikiId, sectionCount: parseInt(rows[0].section_count) };
  }

  const { rows } = await pool.query(
    'SELECT wiki_id, COUNT(*) as section_count FROM wiki_sections GROUP BY wiki_id ORDER BY wiki_id',
  );
  return rows.map((r) => ({
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
  return rows.map((r) => ({
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
  const { rows: empty } = await pool.query(
    `
    SELECT key, title FROM wiki_sections
    ${whereClause} ${whereClause ? 'AND' : 'WHERE'} content = '' OR content IS NULL
  `,
    params,
  );
  results.emptySections = empty.map((r) => ({ key: r.key, title: r.title }));

  // Orphaned sections (no parent, no children, no backlinks)
  const { rows: orphans } = await pool.query(
    `
    SELECT s.key, s.title, s.parent
    FROM wiki_sections s
    ${whereClause} ${whereClause ? 'AND' : 'WHERE'} (
      s.parent IS NULL
      AND NOT EXISTS (SELECT 1 FROM wiki_sections c WHERE c.parent = s.title AND c.wiki_id = s.wiki_id)
      AND NOT EXISTS (SELECT 1 FROM section_links sl WHERE sl.to_key = s.key AND sl.to_wiki_id = s.wiki_id)
    )
  `,
    params,
  );
  results.orphanedSections = orphans.map((r) => ({ key: r.key, title: r.title }));

  // Sections with no backlinks (not linked from anywhere)
  const { rows: unlinked } = await pool.query(
    `
    SELECT s.key, s.title
    FROM wiki_sections s
    ${whereClause} ${whereClause ? 'AND' : 'WHERE'} NOT EXISTS (
      SELECT 1 FROM section_links sl WHERE sl.to_key = s.key AND sl.to_wiki_id = s.wiki_id
    )
    AND s.parent IS NOT NULL
  `,
    params,
  );
  results.unlinkedSections = unlinked.map((r) => ({ key: r.key, title: r.title }));

  return results;
}

/**
 * Create a new section.
 */
export async function createSection({
  wikiId,
  key,
  title,
  content,
  parent = null,
  tags = [],
  relatedKeys = [],
}) {
  // Check for existing section first to give a clear error
  const { rows: existing } = await pool.query(
    'SELECT key FROM wiki_sections WHERE wiki_id = $1 AND key = $2',
    [wikiId, key],
  );
  if (existing.length > 0) {
    return { exists: true };
  }

  const { rows } = await pool.query(
    `
    INSERT INTO wiki_sections (wiki_id, key, parent, title, content, tags, status, metadata)
    VALUES ($1, $2, $3, $4, $5, $6::varchar(100)[], 'active', $7)
    RETURNING id, key, wiki_id, title, parent
  `,
    [wikiId, key, parent, title, content, tags, JSON.stringify({ breadcrumbs: [] })],
  );

  // Generate and store embedding
  if (rows.length > 0) {
    try {
      const embedding = await getEmbedding(`${title}\n${content.slice(0, 2000)}`);
      await pool.query('UPDATE wiki_sections SET embedding = $1 WHERE id = $2', [
        JSON.stringify(embedding),
        rows[0].id,
      ]);
    } catch (err) {
      logger.warn('Failed to generate embedding on create', { key, error: err.message });
    }

    // Auto-link based on embedding similarity
    await relinkSection(wikiId, key);
  }

  return rows[0] || null;
}

/**
 * Update an existing section.
 */
export async function updateSection({
  wikiId,
  key,
  content,
  title,
  parent,
  tags,
  reason,
  relatedKeys,
}) {
  // Check existence first
  const { rows: existing } = await pool.query(
    'SELECT key, title, content FROM wiki_sections WHERE wiki_id = $1 AND key = $2',
    [wikiId, key],
  );
  if (existing.length === 0) {
    return { notFound: true };
  }

  const updates = [];
  const params = [];
  let paramIdx = 1;

  if (content !== undefined) {
    updates.push(`content = $${paramIdx++}`);
    params.push(content);
  }
  if (title !== undefined) {
    updates.push(`title = $${paramIdx++}`);
    params.push(title);
  }
  if (parent !== undefined) {
    updates.push(`parent = $${paramIdx++}`);
    params.push(parent || null);
  }
  if (tags !== undefined) {
    updates.push(`tags = $${paramIdx++}::varchar(100)[]`);
    params.push(tags);
  }

  if (updates.length === 0 && relatedKeys === undefined) return { noChanges: true };

  // If only relatedKeys changed, skip the UPDATE query entirely
  if (updates.length === 0) {
    await relinkSection(wikiId, key);
    return existing[0];
  }

  updates.push('updated_at = NOW()');
  params.push(wikiId, key);

  const { rows } = await pool.query(
    `
    UPDATE wiki_sections SET ${updates.join(', ')}
    WHERE wiki_id = $${paramIdx} AND key = $${paramIdx + 1}
    RETURNING id, key, wiki_id, title, parent
  `,
    params,
  );

  // Log history if content changed
  if (content !== undefined && rows.length > 0) {
    await pool.query(
      `
      INSERT INTO section_history (wiki_id, section_key, content_after, change_reason)
      VALUES ($1, $2, $3, $4)
    `,
      [wikiId, key, content, reason || 'update'],
    );
  }

  // Regenerate embedding if content or title changed
  if (rows.length > 0 && (content !== undefined || title !== undefined)) {
    try {
      const newTitle = title !== undefined ? title : existing[0].title;
      const newContent = content !== undefined ? content : existing[0].content;
      const embedding = await getEmbedding(`${newTitle}\n${newContent.slice(0, 2000)}`);
      await pool.query('UPDATE wiki_sections SET embedding = $1 WHERE id = $2', [
        JSON.stringify(embedding),
        rows[0].id,
      ]);
    } catch (err) {
      logger.warn('Failed to regenerate embedding on update', { key, error: err.message });
    }
  }

  // Auto-link based on embedding similarity
  if (rows.length > 0 && relatedKeys !== undefined) {
    await relinkSection(wikiId, key);
  }

  return rows[0] || null;
}

/**
 * Delete a section.
 */
export async function deleteSection(wikiId, key) {
  const { rows } = await pool.query(
    `
    DELETE FROM wiki_sections WHERE wiki_id = $1 AND key = $2
    RETURNING key, wiki_id, title
  `,
    [wikiId, key],
  );

  // Also delete backlinks
  await pool.query(
    'DELETE FROM section_links WHERE (from_wiki_id = $1 AND from_key = $2) OR (to_wiki_id = $1 AND to_key = $2)',
    [wikiId, key],
  );

  return rows[0] || null;
}

/**
 * Get section history.
 */
export async function getSectionHistory(wikiId, key, limit = 10) {
  const { rows } = await pool.query(
    `
    SELECT content_before, content_after, changed_at, change_reason
    FROM section_history
    WHERE wiki_id = $1 AND section_key = $2
    ORDER BY changed_at DESC
    LIMIT $3
  `,
    [wikiId, key, limit],
  );

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

  const { rows } = await pool.query(
    `
    SELECT key, wiki_id, title,
      LEVENSHTEIN(key, $${params.length + 1}) as distance
    FROM wiki_sections
    ${whereClause} ${whereClause ? 'AND' : 'WHERE'} LEVENSHTEIN(key, $${params.length + 1}) < LENGTH($${params.length + 1})
    ORDER BY distance
    LIMIT $${params.length + 2}
  `,
    [...params, query, maxResults],
  );

  return rows.map((r) => ({ key: r.key, wikiId: r.wiki_id, title: r.title, distance: r.distance }));
}

/**
 * Find similar sections for a given section using vector embeddings.
 * Returns the top N most similar sections (excluding self).
 */
export async function findSimilarSections(key, wikiId = null, limit = 4) {
  const params = [key];
  let whereClause = 'WHERE s.key = $1';
  if (wikiId) {
    whereClause += ' AND s.wiki_id = $2';
    params.push(wikiId);
  }

  // First get the embedding for the target section
  const { rows: targetRows } = await pool.query(
    `SELECT key, wiki_id, embedding FROM wiki_sections s ${whereClause}`,
    params,
  );
  if (targetRows.length === 0 || !targetRows[0].embedding) return [];

  const targetEmbedding = targetRows[0].embedding;
  const targetWikiId = targetRows[0].wiki_id;

  // Find most similar sections using cosine distance
  const { rows } = await pool.query(
    `
    SELECT key, wiki_id, parent, title,
           1 - (embedding <=> $1) as similarity
    FROM wiki_sections
    WHERE wiki_id = $2
      AND key != $3
      AND embedding IS NOT NULL
    ORDER BY embedding <=> $1
    LIMIT $4
  `,
    [targetEmbedding, targetWikiId, key, limit],
  );

  return rows.map((r) => ({
    key: r.key,
    wikiId: r.wiki_id,
    parent: r.parent || 'Root',
    title: r.title,
    similarity: r.similarity,
  }));
}

/**
 * Get all sections with their embeddings for batch similarity computation.
 */
export async function getAllSectionsWithEmbeddings(wikiId = null) {
  const params = [];
  let whereClause = '';
  if (wikiId) {
    whereClause = 'WHERE wiki_id = $1';
    params.push(wikiId);
  }

  const { rows } = await pool.query(
    `SELECT key, wiki_id, parent, title, content, embedding
     FROM wiki_sections
     ${whereClause}
     ORDER BY key`,
    params,
  );

  return rows.map((r) => ({
    key: r.key,
    wikiId: r.wiki_id,
    parent: r.parent || 'Root',
    title: r.title,
    content: r.content,
    embedding: r.embedding,
  }));
}

/**
 * Insert a link into section_links (ON CONFLICT DO NOTHING).
 */
export async function insertSectionLink(fromWikiId, fromKey, toWikiId, toKey) {
  const { rowCount } = await pool.query(
    `INSERT INTO section_links (from_wiki_id, from_key, to_wiki_id, to_key)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT DO NOTHING`,
    [fromWikiId, fromKey, toWikiId, toKey],
  );
  return rowCount > 0;
}

/**
 * Get all outgoing links for a section (what it links to).
 */
export async function getOutgoingLinks(wikiId, key) {
  const { rows } = await pool.query(
    `SELECT sl.to_key, ws.title as to_title
     FROM section_links sl
     JOIN wiki_sections ws ON ws.wiki_id = sl.to_wiki_id AND ws.key = sl.to_key
     WHERE sl.from_wiki_id = $1 AND sl.from_key = $2
     ORDER BY ws.title`,
    [wikiId, key],
  );
  return rows.map((r) => ({ key: r.to_key, title: r.to_title }));
}

/**
 * Update section content and regenerate embedding.
 */
export async function updateSectionContent(key, wikiId, content, _reason = 'auto-link') {
  const { rows } = await pool.query(
    `UPDATE wiki_sections
     SET content = $1, updated_at = NOW()
     WHERE wiki_id = $2 AND key = $3
     RETURNING id, key, wiki_id, title`,
    [content, wikiId, key],
  );

  // Regenerate embedding
  if (rows.length > 0) {
    try {
      const { rows: sectionRows } = await pool.query(
        'SELECT title, content FROM wiki_sections WHERE wiki_id = $1 AND key = $2',
        [wikiId, key],
      );
      if (sectionRows.length > 0) {
        const { getEmbedding } = await import('./embedding.js');
        const embedding = await getEmbedding(
          `${sectionRows[0].title}\n${sectionRows[0].content.slice(0, 2000)}`,
        );
        await pool.query('UPDATE wiki_sections SET embedding = $1 WHERE id = $2', [
          JSON.stringify(embedding),
          rows[0].id,
        ]);
      }
    } catch (err) {
      logger.warn('Failed to regenerate embedding on auto-link', { key, error: err.message });
    }
  }

  return rows[0] || null;
}

/**
 * Increment access count and update last_accessed timestamp.
 * Capped at MAX_ACCESS_COUNT to prevent overflow.
 */
export async function incrementAccessCount(wikiId, key) {
  await pool.query(
    `UPDATE wiki_sections
     SET access_count = LEAST(access_count + 1, $1),
         last_accessed = NOW()
     WHERE wiki_id = $2 AND key = $3`,
    [MAX_ACCESS_COUNT, wikiId, key],
  );
}

/**
 * Re-link a section based on embedding similarity.
 * Deletes existing outgoing links and inserts new ones.
 */
export async function relinkSection(wikiId, key) {
  // Delete existing outgoing links
  await pool.query(`DELETE FROM section_links WHERE from_wiki_id = $1 AND from_key = $2`, [
    wikiId,
    key,
  ]);

  // Find similar sections
  const similar = await findSimilarSections(key, wikiId, MAX_LINKS_PER_SECTION);
  if (similar.length < 2) return;

  // Insert new links
  for (const target of similar) {
    await insertSectionLink(wikiId, key, target.wikiId, target.key);
  }
}

export { pool };
