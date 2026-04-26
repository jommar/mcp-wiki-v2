import pkg from 'pg';
const { Pool } = pkg;
import { logger } from '../logger.js';
import { getEmbedding } from './embedding.js';
import { requestContext } from './context.js';

// Constants for auto-linking and access tracking
const MAX_ACCESS_COUNT = 9999;
const MAX_LINKS_PER_SECTION = parseInt(process.env.MAX_LINKS_PER_SECTION, 10) || 4;

// Global pool — used for stdio mode and server startup migrations
const globalPool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5433'),
  user: process.env.DB_USER || 'wiki',
  password: process.env.DB_PASSWORD || 'wiki',
  database: process.env.DB_NAME || 'wiki',
});

// Enable extensions on the global pool at startup
globalPool.query('CREATE EXTENSION IF NOT EXISTS fuzzystrmatch').catch(() => {});

// Per-request pool: from authenticated client context (HTTP) or global (stdio)
function getPool() {
  const ctx = requestContext.getStore();
  if (!ctx && process.env.TRANSPORT === 'http') {
    throw new Error(
      'No request context found in HTTP mode — possible unauthenticated code path. ' +
        'All HTTP requests must be authenticated and routed through requestContext.run().',
    );
  }
  return ctx?.pool ?? globalPool;
}

/**
 * List all sections with optional wiki_id filter and offset pagination.
 */
export async function listSections(wikiId = null, limit = 100, offset = 0) {
  const query = wikiId
    ? `SELECT key, wiki_id, parent, title, tags, metadata, LENGTH(content) as content_length,
              (SELECT COUNT(*) FROM section_links sl WHERE sl.from_wiki_id = ws.wiki_id AND sl.from_key = ws.key) as link_count
       FROM wiki_sections ws WHERE wiki_id = $1 ORDER BY key LIMIT $2 OFFSET $3`
    : `SELECT key, wiki_id, parent, title, tags, metadata, LENGTH(content) as content_length,
              (SELECT COUNT(*) FROM section_links sl WHERE sl.from_wiki_id = ws.wiki_id AND sl.from_key = ws.key) as link_count
       FROM wiki_sections ws ORDER BY wiki_id, key LIMIT $1 OFFSET $2`;
  const { rows } = await getPool().query(query, wikiId ? [wikiId, limit, offset] : [limit, offset]);
  return rows.map((r) => ({
    key: r.key,
    wikiId: r.wiki_id,
    parent: r.parent || 'Root',
    title: r.title,
    tags: r.tags || [],
    breadcrumbs: r.metadata?.breadcrumbs || [],
    contentLength: r.content_length,
    linkCount: parseInt(r.link_count) || 0,
  }));
}

/**
 * Browse sections by parent topic.
 */
export async function browseSections(topic, wikiId = null, limit = 100, offset = 0) {
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
  query += ' ORDER BY parent, key LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2);
  params.push(limit, offset);

  const { rows } = await getPool().query(query, params);
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
async function searchSemantic(query, { wikiId, parent, limit, offset = 0 }) {
  try {
    const embedding = await getEmbedding(query);
    const params = [JSON.stringify(embedding)];
    const conditions = ['embedding IS NOT NULL'];
    if (wikiId) {
      conditions.push(`wiki_id = $${params.length + 1}`);
      params.push(wikiId);
    }
    if (parent) {
      conditions.push(`LOWER(parent) LIKE $${params.length + 1}`);
      params.push(`%${parent.toLowerCase()}%`);
    }
    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const searchQuery = `
      SELECT key, wiki_id, parent, title, metadata->'breadcrumbs' as breadcrumbs,
             1 - (embedding <=> $1) as similarity,
             LENGTH(content) as content_length,
             LEFT(content, 200) as snippet
      FROM wiki_sections
      ${whereClause}
      ORDER BY embedding <=> $1
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;
    params.push(limit, offset);

    const { rows } = await getPool().query(searchQuery, params);
    return rows.map((r) => ({
      key: r.key,
      wikiId: r.wiki_id,
      parent: r.parent || 'Root',
      title: r.title,
      breadcrumbs: r.breadcrumbs || [],
      rank: r.similarity,
      contentLength: r.content_length,
      snippet: r.snippet,
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
export async function searchSections(
  query,
  { wikiId = null, parent = null, fuzzy = false, limit = 20, offset = 0 } = {},
) {
  if (fuzzy) {
    // Fall back to trigram similarity for fuzzy matching
    return searchFuzzy(query, { wikiId, parent, limit, offset });
  }

  // Try semantic search first
  const semanticResults = await searchSemantic(query, { wikiId, parent, limit, offset });

  // If we got results with meaningful similarity, use them
  const similarityThreshold = parseFloat(process.env.SIMILARITY_THRESHOLD || '0.1');
  if (semanticResults.length > 0 && semanticResults.some((r) => r.rank > similarityThreshold)) {
    return semanticResults;
  }

  // Fall back to keyword search
  const params = [];
  const conditions = [];

  if (wikiId) {
    conditions.push(`wiki_id = $${params.length + 1}`);
    params.push(wikiId);
  }
  if (parent) {
    conditions.push(`LOWER(parent) LIKE $${params.length + 1}`);
    params.push(`%${parent.toLowerCase()}%`);
  }
  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

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
           LENGTH(content) as content_length,
           LEFT(content, 200) as snippet
    FROM wiki_sections
    ${whereClause} ${whereClause ? 'AND' : 'WHERE'} search_vector @@ to_tsquery('english', $${params.length + 1})
    ORDER BY rank DESC
    LIMIT $${params.length + 2} OFFSET $${params.length + 3}
  `;
  params.push(searchTerms, limit, offset);

  const { rows } = await getPool().query(searchQuery, params);
  return rows.map((r) => ({
    key: r.key,
    wikiId: r.wiki_id,
    parent: r.parent || 'Root',
    title: r.title,
    breadcrumbs: r.breadcrumbs || [],
    rank: r.rank,
    contentLength: r.content_length,
    snippet: r.snippet,
  }));
}

/**
 * Fuzzy search using trigram similarity.
 */
async function searchFuzzy(query, { wikiId, parent, limit, offset = 0 }) {
  const params = [];
  const conditions = [];

  if (wikiId) {
    conditions.push(`wiki_id = $${params.length + 1}`);
    params.push(wikiId);
  }
  if (parent) {
    conditions.push(`LOWER(parent) LIKE $${params.length + 1}`);
    params.push(`%${parent.toLowerCase()}%`);
  }
  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const searchQuery = `
    SELECT key, wiki_id, parent, title, metadata->'breadcrumbs' as breadcrumbs,
           GREATEST(
             similarity(title, $${params.length + 1}),
             similarity(key, $${params.length + 1})
           ) as score,
           LENGTH(content) as content_length,
           LEFT(content, 200) as snippet
    FROM wiki_sections
    ${whereClause} ${whereClause ? 'AND' : 'WHERE'} (
      title % $${params.length + 1}
      OR key % $${params.length + 1}
      OR content ILIKE $${params.length + 1}
    )
    ORDER BY score DESC
    LIMIT $${params.length + 2} OFFSET $${params.length + 3}
  `;
  params.push(query, limit, offset);

  const { rows } = await getPool().query(searchQuery, params);
  return rows.map((r) => ({
    key: r.key,
    wikiId: r.wiki_id,
    parent: r.parent || 'Root',
    title: r.title,
    breadcrumbs: r.breadcrumbs || [],
    rank: r.score,
    contentLength: r.content_length,
    snippet: r.snippet,
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
           LENGTH(content) as total_length,
           updated_at
    FROM wiki_sections s
    ${whereClause}
  `;

  const { rows } = await getPool().query(query, params);
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
    updatedAt: row.updated_at?.toISOString() ?? null,
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
    SELECT key, wiki_id, parent, title, metadata, content, LENGTH(content) as total_length, updated_at
    FROM wiki_sections
    ${whereClause}
    ORDER BY array_position($1, key)
  `;

  const { rows } = await getPool().query(query, params);
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
      updatedAt: r.updated_at?.toISOString() ?? null,
    };
  });
}

/**
 * Get wiki info (section count, etc).
 */
export async function getWikiInfo(wikiId = null) {
  if (wikiId) {
    const { rows } = await getPool().query(
      'SELECT COUNT(*) as section_count FROM wiki_sections WHERE wiki_id = $1',
      [wikiId],
    );
    return { wikiId, sectionCount: parseInt(rows[0].section_count) };
  }

  const { rows } = await getPool().query(
    'SELECT wiki_id, COUNT(*) as section_count FROM wiki_sections GROUP BY wiki_id ORDER BY wiki_id',
  );
  return rows.map((r) => ({
    wikiId: r.wiki_id,
    sectionCount: parseInt(r.section_count),
  }));
}

/**
 * Get backlinks for a section (what other sections link to it).
 * Fetches limit+1 to detect hasMore, then trims.
 */
export async function getBacklinks(key, wikiId = null, limit = 50) {
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
    LIMIT $${params.length + 1}
  `;
  params.push(limit + 1);

  const { rows } = await getPool().query(query, params);
  const hasMore = !!(rows.length > limit);
  if (hasMore) rows.pop();

  return {
    backlinks: rows.map((r) => ({
      key: r.from_key,
      wikiId: r.from_wiki_id,
      title: r.from_title,
      parent: r.from_parent || 'Root',
    })),
    hasMore,
  };
}

/**
 * Validate wiki health (empty sections, orphans, etc).
 * Returns counts only — no full row data.
 */
export async function validateWiki(wikiId = null) {
  const params = [];
  let whereClause = '';
  if (wikiId) {
    whereClause = `WHERE wiki_id = $1`;
    params.push(wikiId);
  }

  const { rows: emptyRows } = await getPool().query(
    `SELECT COUNT(*) as count FROM wiki_sections
     ${whereClause} ${whereClause ? 'AND' : 'WHERE'} (content = '' OR content IS NULL)`,
    params,
  );

  const { rows: orphanRows } = await getPool().query(
    `SELECT COUNT(*) as count FROM wiki_sections s
     ${whereClause} ${whereClause ? 'AND' : 'WHERE'} (
       (
         s.parent IS NULL
         AND NOT EXISTS (SELECT 1 FROM wiki_sections c WHERE c.parent = s.title AND c.wiki_id = s.wiki_id)
         AND NOT EXISTS (SELECT 1 FROM section_links sl WHERE sl.to_key = s.key AND sl.to_wiki_id = s.wiki_id)
       )
       OR (
         s.parent IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM wiki_sections p WHERE p.title = s.parent AND p.wiki_id = s.wiki_id)
         AND NOT EXISTS (SELECT 1 FROM section_links sl WHERE sl.to_key = s.key AND sl.to_wiki_id = s.wiki_id)
       )
     )`,
    params,
  );

  const { rows: unlinkedRows } = await getPool().query(
    `SELECT COUNT(*) as count FROM wiki_sections s
     ${whereClause} ${whereClause ? 'AND' : 'WHERE'} NOT EXISTS (
       SELECT 1 FROM section_links sl WHERE sl.to_key = s.key AND sl.to_wiki_id = s.wiki_id
     )
     AND s.parent IS NOT NULL`,
    params,
  );

  const emptyCount = parseInt(emptyRows[0].count);
  const orphanCount = parseInt(orphanRows[0].count);
  const unlinkedCount = parseInt(unlinkedRows[0].count);

  return {
    emptySectionsCount: emptyCount,
    orphanedSectionsCount: orphanCount,
    unlinkedSectionsCount: unlinkedCount,
    healthy: !!(emptyCount === 0 && orphanCount === 0 && unlinkedCount === 0),
  };
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
  skipLink = false,
}) {
  // Check for existing section first to give a clear error
  const { rows: existing } = await getPool().query(
    'SELECT key FROM wiki_sections WHERE wiki_id = $1 AND key = $2',
    [wikiId, key],
  );
  if (existing.length > 0) {
    return { exists: true };
  }

  const { rows } = await getPool().query(
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
      await getPool().query('UPDATE wiki_sections SET embedding = $1 WHERE id = $2', [
        JSON.stringify(embedding),
        rows[0].id,
      ]);
    } catch (err) {
      logger.warn('Failed to generate embedding on create', { key, error: err.message });
    }

    // Links are managed by the app layer (insertExplicitLinks / relinkSection).
    // The extract_backlinks() DB trigger was removed in migration 004 — the
    // [[key]] syntax in content is for human readability only, not linking.
    if (!skipLink) {
      if (relatedKeys.length > 0) {
        await insertExplicitLinks(wikiId, key, relatedKeys);
      } else {
        await relinkSection(wikiId, key);
      }
    }
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
  const { rows: existing } = await getPool().query(
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
    await insertExplicitLinks(wikiId, key, relatedKeys);
    return existing[0];
  }

  updates.push('updated_at = NOW()');
  params.push(wikiId, key);

  const { rows } = await getPool().query(
    `
    UPDATE wiki_sections SET ${updates.join(', ')}
    WHERE wiki_id = $${paramIdx} AND key = $${paramIdx + 1}
    RETURNING id, key, wiki_id, title, parent
  `,
    params,
  );

  // Log history if content changed — stores both old and new content
  if (content !== undefined && rows.length > 0) {
    const oldContent = existing[0].content || '';
    await getPool().query(
      `
      INSERT INTO section_history (wiki_id, section_key, content_before, content_after, change_reason)
      VALUES ($1, $2, $3, $4, $5)
    `,
      [wikiId, key, oldContent, content, reason || 'update'],
    );
  }

  // Regenerate embedding if content or title changed
  if (rows.length > 0 && (content !== undefined || title !== undefined)) {
    try {
      const newTitle = title !== undefined ? title : existing[0].title;
      const newContent = content !== undefined ? content : existing[0].content;
      const embedding = await getEmbedding(`${newTitle}\n${newContent.slice(0, 2000)}`);
      await getPool().query('UPDATE wiki_sections SET embedding = $1 WHERE id = $2', [
        JSON.stringify(embedding),
        rows[0].id,
      ]);
    } catch (err) {
      logger.warn('Failed to regenerate embedding on update', { key, error: err.message });
    }
  }

  // Update links: use explicit relatedKeys if provided, relink if embedding changed
  // App layer is the sole manager of section_links (trigger removed in migration 004).
  if (rows.length > 0) {
    if (relatedKeys !== undefined) {
      await insertExplicitLinks(wikiId, key, relatedKeys);
    } else if (content !== undefined || title !== undefined) {
      await relinkSection(wikiId, key);
    }
  }

  return rows[0] || null;
}

/**
 * Delete a section.
 */
export async function deleteSection(wikiId, key) {
  const { rows } = await getPool().query(
    `
    DELETE FROM wiki_sections WHERE wiki_id = $1 AND key = $2
    RETURNING key, wiki_id, title
  `,
    [wikiId, key],
  );

  // Also delete backlinks
  await getPool().query(
    'DELETE FROM section_links WHERE (from_wiki_id = $1 AND from_key = $2) OR (to_wiki_id = $1 AND to_key = $2)',
    [wikiId, key],
  );

  return rows[0] || null;
}

/**
 * Get section history.
 */
export async function getSectionHistory(wikiId, key, limit = 10) {
  const params = [key];
  let whereClause = 'WHERE section_key = $1';
  if (wikiId) {
    whereClause += ' AND wiki_id = $2';
    params.push(wikiId);
  }
  params.push(limit);

  const { rows } = await getPool().query(
    `SELECT content_before, content_after, changed_at, change_reason
     FROM section_history
     ${whereClause}
     ORDER BY changed_at DESC
     LIMIT $${params.length}`,
    params,
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

  const { rows } = await getPool().query(
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
 * Falls back to keyword (Levenshtein) similarity if the target section
 * has no embedding, with a clear log warning.
 */
export async function findSimilarSections(key, wikiId = null, limit = 4) {
  // First check if the target section has an embedding
  const { rows: targetCheck } = await getPool().query(
    `SELECT embedding FROM wiki_sections WHERE key = $1 ${wikiId ? 'AND wiki_id = $2' : ''} LIMIT 1`,
    wikiId ? [key, wikiId] : [key],
  );

  if (targetCheck.length === 0 || !targetCheck[0].embedding) {
    logger.warn(
      'findSimilarSections: target section has no embedding, falling back to keyword similarity',
      {
        key,
        wikiId,
      },
    );
    return findSimilar(key, wikiId, limit);
  }

  const { rows } = await getPool().query(
    `
    WITH target_section AS (
      SELECT embedding, wiki_id 
      FROM wiki_sections 
      WHERE key = $1 
        ${wikiId ? 'AND wiki_id = $2' : ''}
      LIMIT 1
    )
    SELECT 
      s.key, 
      s.wiki_id, 
      s.parent, 
      s.title,
      1 - (s.embedding <=> t.embedding) as similarity
    FROM wiki_sections s
    JOIN target_section t ON s.wiki_id = t.wiki_id
    WHERE s.key != $1
      AND s.embedding IS NOT NULL
    ORDER BY s.embedding <=> t.embedding
    LIMIT $${wikiId ? '3' : '2'}
  `,
    wikiId ? [key, wikiId, limit] : [key, limit],
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

  const { rows } = await getPool().query(
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
  const { rowCount } = await getPool().query(
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
  const { rows } = await getPool().query(
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
 * Clear all outgoing links for a section (used when re-linking with override).
 */
export async function clearOutgoingLinks(wikiId, key) {
  const { rowCount } = await getPool().query(
    'DELETE FROM section_links WHERE from_wiki_id = $1 AND from_key = $2',
    [wikiId, key],
  );
  return rowCount;
}

/**
 * Update section embedding without changing content.
 */
export async function updateSectionEmbedding(wikiId, key, embedding) {
  const { rowCount } = await getPool().query(
    'UPDATE wiki_sections SET embedding = $1 WHERE wiki_id = $2 AND key = $3',
    [JSON.stringify(embedding), wikiId, key],
  );
  return rowCount;
}

/**
 * Update section content and regenerate embedding.
 */
export async function updateSectionContent(key, wikiId, content, _reason = 'auto-link') {
  const { rows } = await getPool().query(
    `UPDATE wiki_sections
     SET content = $1, updated_at = NOW()
     WHERE wiki_id = $2 AND key = $3
     RETURNING id, key, wiki_id, title`,
    [content, wikiId, key],
  );

  // Regenerate embedding
  if (rows.length > 0) {
    try {
      const { rows: sectionRows } = await getPool().query(
        'SELECT title, content FROM wiki_sections WHERE wiki_id = $1 AND key = $2',
        [wikiId, key],
      );
      if (sectionRows.length > 0) {
        const { getEmbedding } = await import('./embedding.js');
        const embedding = await getEmbedding(
          `${sectionRows[0].title}\n${sectionRows[0].content.slice(0, 2000)}`,
        );
        await getPool().query('UPDATE wiki_sections SET embedding = $1 WHERE id = $2', [
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
  await getPool().query(
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
 * If skipIfLinked is true, does nothing when the section already has outgoing links.
 * App layer is the sole manager of section_links (trigger removed in migration 004).
 */
export async function relinkSection(wikiId, key, { skipIfLinked = false } = {}) {
  if (skipIfLinked) {
    const { rowCount } = await getPool().query(
      'SELECT 1 FROM section_links WHERE from_wiki_id = $1 AND from_key = $2 LIMIT 1',
      [wikiId, key],
    );
    if (rowCount > 0) return;
  }

  // Delete existing outgoing links
  await getPool().query(`DELETE FROM section_links WHERE from_wiki_id = $1 AND from_key = $2`, [
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

/**
 * Insert explicit section links from relatedKeys.
 * Validates targets exist to avoid FK violations, logs unknown keys as warnings.
 * Clears existing outgoing links first (replaces, not appends).
 * Uses a single bulk INSERT via UNNEST instead of N individual INSERTs.
 */
export async function insertExplicitLinks(wikiId, fromKey, relatedKeys) {
  await clearOutgoingLinks(wikiId, fromKey);
  if (relatedKeys.length === 0) return;

  const { rows } = await getPool().query(
    'SELECT key FROM wiki_sections WHERE wiki_id = $1 AND key = ANY($2)',
    [wikiId, relatedKeys],
  );
  const validKeys = new Set(rows.map((r) => r.key));

  const invalid = relatedKeys.filter((k) => !validKeys.has(k));
  if (invalid.length > 0) {
    logger.warn('insertExplicitLinks: relatedKeys not found, skipping', {
      wikiId,
      fromKey,
      invalid,
    });
  }

  const valid = relatedKeys.filter((k) => validKeys.has(k));
  if (valid.length > 0) {
    await getPool().query(
      `INSERT INTO section_links (from_wiki_id, from_key, to_wiki_id, to_key)
       SELECT $1, $2, $3, UNNEST($4::text[])
       ON CONFLICT DO NOTHING`,
      [wikiId, fromKey, wikiId, valid],
    );
  }
}

export { globalPool as pool };
