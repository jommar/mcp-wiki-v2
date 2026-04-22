// src/service.js - Business logic layer
// Contains constants, validation, data transformation, and orchestration

import * as db from './db.js';
import * as wikiExport from './export.js';
import * as wikiImport from './import.js';
import { logger } from '../logger.js';
import { getEmbedding } from './embedding.js';

// Constants
export const MAX_BATCH_KEYS = 20;
export const MAX_CONTENT_LENGTH = 8000;
export const MAX_CONTENT_SIZE = 50000; // 50KB hard limit for writes
export const KEY_PATTERN = /^[a-z0-9-]+$/;

// Key validation
export function validateKey(key) {
  if (!key || !key.trim()) return 'Key cannot be empty';
  if (!KEY_PATTERN.test(key)) {
    return `Invalid key format: "${key}". Keys must be lowercase alphanumeric with hyphens`;
  }
  if (key.length > 255) return `Key too long (${key.length} chars, max 255)`;
  return null;
}

// Response formatting helper
export function formatResponse(structured) {
  return {
    content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],
    structuredContent: structured,
  };
}

// ─── READ OPERATIONS ───────────────────────────────────────────────────────────

export async function listWiki(wikiId, limit) {
  const sections = await db.listSections(wikiId || null, limit);
  return formatResponse({ sections, count: sections.length });
}

export async function browseWiki(topic, wikiId, limit) {
  const sections = await db.browseSections(topic || null, wikiId || null, limit);

  const byParent = {};
  for (const s of sections) {
    if (!byParent[s.parent]) byParent[s.parent] = [];
    byParent[s.parent].push({
      key: s.key,
      wikiId: s.wikiId,
      title: s.title,
      depth: s.depth,
      breadcrumbs: s.breadcrumbs,
    });
  }

  const groups = Object.entries(byParent).map(([parent, secs]) => ({ parent, sections: secs }));
  return formatResponse({ groups, count: sections.length });
}

export async function searchWiki(query, wikiId, fuzzy, limit) {
  const results = await db.searchSections(query, { wikiId: wikiId || null, fuzzy, limit });

  if (results.length === 0) {
    const similar = await db.findSimilar(query, wikiId || null);
    const suggestions = similar.map((s) => ({ key: s.key, wikiId: s.wikiId }));
    return formatResponse({
      results: [],
      count: 0,
      suggestions: suggestions.length > 0 ? suggestions : undefined,
    });
  }

  const formattedResults = results.map((r) => ({
    key: r.key,
    wikiId: r.wikiId,
    parent: r.parent,
    title: r.title,
    breadcrumbs: r.breadcrumbs,
    snippet: r.snippet || undefined,
  }));

  return formatResponse({ results: formattedResults, count: results.length });
}

export async function getWikiSection(key, wikiId, offset, limit, includeBacklinks = false) {
  const keyError = validateKey(key);
  if (keyError) {
    return formatResponse({ error: keyError });
  }

  const section = await db.getSection(key, { wikiId: wikiId || null, offset, limit });
  if (!section) {
    const similar = await db.findSimilar(key, wikiId || null);
    const suggestions = similar.map((s) => s.key);
    return formatResponse({
      error: `Section '${key}' not found`,
      suggestions: suggestions.length > 0 ? suggestions : undefined,
    });
  }

  const relatedSections = await db.getOutgoingLinks(wikiId || section.wikiId, key);

  // Fire-and-forget: track access and re-link in background
  db.incrementAccessCount(wikiId || section.wikiId, section.key).catch((err) =>
    logger.warn('Failed to increment access count', { key: section.key, error: err.message }),
  );
  db.relinkSection(wikiId || section.wikiId, section.key).catch((err) =>
    logger.warn('Failed to relink section', { key: section.key, error: err.message }),
  );

  let backlinks;
  if (includeBacklinks) {
    backlinks = await db.getBacklinks(key, wikiId || null);
  }

  return formatResponse({
    key: section.key,
    title: section.title,
    parent: section.parent,
    breadcrumbs: section.breadcrumbs,
    wikiId: section.wikiId,
    source: section.source,
    content: section.content,
    totalLength: section.totalLength,
    offset: section.offset,
    limit: section.limit,
    hasMore: section.hasMore,
    nextOffset: section.nextOffset,
    updatedAt: section.updatedAt,
    relatedSections,
    ...(includeBacklinks && { backlinks }),
  });
}

export async function getWikiSections(keys, wikiId) {
  const keyErrors = new Map();
  for (const k of keys) {
    const err = validateKey(k);
    if (err) keyErrors.set(k, err);
  }

  const validKeys = keys.filter((k) => !keyErrors.has(k));
  const sections =
    validKeys.length > 0 ? await db.getSections(validKeys, { wikiId: wikiId || null }) : [];

  const allSections = keys.map((k) => {
    if (keyErrors.has(k)) return { key: k, error: keyErrors.get(k) };
    const section = sections.find((s) => s.key === k);
    if (!section) return { key: k, error: `Section '${k}' not found` };
    return section;
  });

  const errorCount = allSections.filter((s) => s.error).length;

  // Fire-and-forget: track access and re-link for each successfully returned section
  for (const s of allSections) {
    if (!s.error) {
      db.incrementAccessCount(wikiId || s.wikiId, s.key).catch((err) =>
        logger.warn('Failed to increment access count', { key: s.key, error: err.message }),
      );
      db.relinkSection(wikiId || s.wikiId, s.key).catch((err) =>
        logger.warn('Failed to relink section', { key: s.key, error: err.message }),
      );
    }
  }

  return formatResponse({
    sections: allSections,
    successCount: keys.length - errorCount,
    errorCount,
  });
}

export async function getWikiInfo(wikiId) {
  const info = await db.getWikiInfo(wikiId || null);
  const wikis = Array.isArray(info) ? info : [info];
  return formatResponse({ wikis });
}

export async function getBacklinks(key, wikiId) {
  const backlinks = await db.getBacklinks(key, wikiId || null);
  return formatResponse({ backlinks, count: backlinks.length });
}

export async function validateWiki(wikiId) {
  const results = await db.validateWiki(wikiId || null);
  return formatResponse({
    ...results,
    emptySectionsCount: results.emptySections.length,
    orphanedSectionsCount: results.orphanedSections.length,
    unlinkedSectionsCount: results.unlinkedSections.length,
  });
}

export async function getSectionHistory(wikiId, key, limit) {
  const history = await db.getSectionHistory(wikiId, key, limit);
  return formatResponse({
    history: history.map((h) => ({
      contentBefore: h.content_before ?? undefined,
      contentAfter: h.content_after,
      changedAt: h.changed_at instanceof Date ? h.changed_at.toISOString() : String(h.changed_at),
      changeReason: h.change_reason ?? undefined,
    })),
    count: history.length,
  });
}

// ─── WRITE OPERATIONS ───────────────────────────────────────────────────────────

export async function createSection(wikiId, key, title, content, parent, tags, relatedKeys) {
  const keyError = validateKey(key);
  if (keyError) throw new Error(keyError);

  if (!content || !content.trim()) throw new Error('Content cannot be empty');
  if (content.length > MAX_CONTENT_SIZE) {
    throw new Error(`Content too large (${content.length} chars, max ${MAX_CONTENT_SIZE})`);
  }

  const result = await db.createSection({
    wikiId,
    key,
    title,
    content,
    parent: parent || null,
    tags: tags || [],
    relatedKeys: relatedKeys || [],
  });
  if (result && result.key) {
    return formatResponse({
      key: result.key,
      wikiId: result.wiki_id,
      title: result.title,
      parent: result.parent,
      created: true,
    });
  }
  if (result && result.exists) {
    throw new Error(`Section '${key}' already exists in ${wikiId}`);
  }
  throw new Error(`Failed to create section '${key}' in ${wikiId}`);
}

export async function updateSection(
  wikiId,
  key,
  content,
  title,
  parent,
  tags,
  reason,
  relatedKeys,
) {
  const keyError = validateKey(key);
  if (keyError) throw new Error(keyError);

  if (content !== undefined && content.length > MAX_CONTENT_SIZE) {
    throw new Error(`Content too large (${content.length} chars, max ${MAX_CONTENT_SIZE})`);
  }

  const result = await db.updateSection({
    wikiId,
    key,
    content,
    title,
    parent,
    tags,
    reason,
    relatedKeys,
  });
  if (result && result.key) {
    return formatResponse({
      key: result.key,
      wikiId: result.wiki_id,
      title: result.title,
      updated: true,
    });
  }
  if (result && result.notFound) throw new Error(`Section '${key}' not found in ${wikiId}`);
  if (result && result.noChanges) throw new Error('No fields provided to update');
  throw new Error(`Failed to update section '${key}' in ${wikiId}`);
}

export async function deleteSection(wikiId, key) {
  const result = await db.deleteSection(wikiId, key);
  if (result) {
    return formatResponse({
      key: result.key,
      wikiId: result.wiki_id,
      title: result.title,
      deleted: true,
    });
  }
  throw new Error(`Section '${key}' not found in ${wikiId}`);
}

// ─── IMPORT OPERATIONS ────────────────────────────────────────────────────────

export async function importWiki() {
  // Process all files in staging
  const result = await wikiImport.processStaging();

  // If any files were imported successfully, run auto-link for affected wikis
  if (result.success > 0) {
    logger.info('Running auto-link for all wikis after import');
    await autoLinkSections(null);
  }

  return formatResponse(result);
}

// ─── EXPORT OPERATIONS ────────────────────────────────────────────────────────

export async function exportWiki(outputDir, wikiId) {
  let results;
  if (wikiId) {
    const result = await wikiExport.exportWiki(wikiId, outputDir);
    results = [result];
  } else {
    results = await wikiExport.exportAllWikis(outputDir);
  }
  return formatResponse({ results });
}

// ─── AUTO-LINK OPERATIONS ─────────────────────────────────────────────────────

async function processSectionLinks(section, wikiId, options) {
  const { minSimilarity, maxLinks, override, reembed } = options;

  // Regenerate embedding if requested
  if (reembed) {
    try {
      const embedding = await getEmbedding(
        `${section.title}\n${section.content.slice(0, 2000)}`,
      );
      await db.updateSectionEmbedding(section.wikiId, section.key, embedding);
    } catch (err) {
      logger.warn('processSectionLinks: Failed to re-embed', {
        key: section.key,
        error: err.message,
      });
    }
  }

  // Clear existing links if override is true
  if (override) {
    await db.clearOutgoingLinks(section.wikiId, section.key);
  } else {
    // Skip if already has outgoing links (only when not overriding)
    const existingLinks = await db.getOutgoingLinks(section.wikiId, section.key);
    if (existingLinks.length > 0) {
      return { skipped: 1, updated: 0 };
    }
  }

  // Find similar sections using embeddings
  const similar = await db.findSimilarSections(section.key, wikiId, maxLinks + 2);
  const filtered = similar.filter((s) => s.similarity >= minSimilarity).slice(0, maxLinks);

  if (filtered.length < 2) {
    return { skipped: 1, updated: 0 };
  }

  let inserted = 0;
  for (const target of filtered) {
    const ok = await db.insertSectionLink(section.wikiId, section.key, target.wikiId, target.key);
    if (ok) inserted++;
  }

  return inserted > 0 ? { skipped: 0, updated: 1 } : { skipped: 1, updated: 0 };
}

export async function autoLinkSections(wikiId, options = {}) {
  const { minSimilarity = 0.1, maxLinks = 4, override = false, parallel = true, reembed = false } = options;

  const sections = await db.getAllSectionsWithEmbeddings(wikiId || null);
  const sectionsWithEmbeddings = sections.filter((s) => s.embedding);

  if (sectionsWithEmbeddings.length === 0) {
    logger.info('autoLinkSections: No sections with embeddings found.', { wikiId });
    return;
  }

  let updated = 0;
  let skipped = 0;

  if (parallel) {
    // Process in parallel using Promise.all
    const results = await Promise.all(
      sectionsWithEmbeddings.map((section) =>
        processSectionLinks(section, wikiId, { minSimilarity, maxLinks, override, reembed }).catch((err) => {
          logger.warn('autoLinkSections: Error processing section', {
            key: section.key,
            error: err.message,
          });
          return { skipped: 1, updated: 0 };
        }),
      ),
    );
    for (const result of results) {
      updated += result.updated;
      skipped += result.skipped;
    }
  } else {
    // Process sequentially
    for (const section of sectionsWithEmbeddings) {
      const result = await processSectionLinks(section, wikiId, {
        minSimilarity,
        maxLinks,
        override,
        reembed,
      });
      updated += result.updated;
      skipped += result.skipped;
    }
  }

  logger.info('autoLinkSections: Completed', {
    wikiId: wikiId || 'all',
    updated,
    skipped,
    total: sectionsWithEmbeddings.length,
    override,
    reembed,
    parallel,
  });
  return;
}
