// src/service.js - Business logic layer
// Contains constants, validation, data transformation, and orchestration

import * as db from './db.js';
import * as wikiImport from './import.js';
import * as wikiExport from './export.js';

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
    const suggestions = similar.map((s) => s.key);
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
  }));

  return formatResponse({ results: formattedResults, count: results.length });
}

export async function getWikiSection(key, wikiId, offset, limit) {
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

  // Find related sections by key prefix
  const prefix = key.split('-').slice(0, 2).join('-');
  const related = await db.browseSections(prefix, wikiId || null);
  const relatedSections = related
    .filter((r) => r.key !== key)
    .slice(0, 5)
    .map((r) => ({ key: r.key, title: r.title }));

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
    relatedSections,
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
  return formatResponse(results);
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
  if (keyError) return formatResponse({ created: false, error: keyError });

  if (!content || !content.trim()) {
    return formatResponse({ created: false, error: 'Content cannot be empty' });
  }
  if (content.length > MAX_CONTENT_SIZE) {
    return formatResponse({
      created: false,
      error: `Content too large (${content.length} chars, max ${MAX_CONTENT_SIZE})`,
    });
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
      created: true,
    });
  }
  if (result && result.exists) {
    return formatResponse({
      created: false,
      error: `Section '${key}' already exists in ${wikiId}`,
    });
  }
  return formatResponse({
    created: false,
    error: `Failed to create section '${key}' in ${wikiId}`,
  });
}

export async function updateSection(wikiId, key, content, title, parent, tags, reason, relatedKeys) {
  const keyError = validateKey(key);
  if (keyError) return formatResponse({ updated: false, error: keyError });

  if (content !== undefined && content.length > MAX_CONTENT_SIZE) {
    return formatResponse({
      updated: false,
      error: `Content too large (${content.length} chars, max ${MAX_CONTENT_SIZE})`,
    });
  }

  const result = await db.updateSection({ wikiId, key, content, title, parent, tags, reason, relatedKeys });
  if (result && result.key) {
    return formatResponse({
      key: result.key,
      wikiId: result.wiki_id,
      title: result.title,
      updated: true,
    });
  }
  if (result && result.notFound) {
    return formatResponse({ updated: false, error: `Section '${key}' not found in ${wikiId}` });
  }
  if (result && result.noChanges) {
    return formatResponse({ updated: false, error: 'No fields provided to update' });
  }
  return formatResponse({
    updated: false,
    error: `Failed to update section '${key}' in ${wikiId}`,
  });
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
  return formatResponse({ deleted: false, error: `Section '${key}' not found in ${wikiId}` });
}

// ─── IMPORT/EXPORT OPERATIONS ───────────────────────────────────────────────────

export async function importWiki(sourcePath, wikiId) {
  const result = await wikiImport.importWiki(sourcePath, wikiId || null);
  return formatResponse(result);
}

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

export async function autoLinkSections(wikiId, options = {}) {
  const { minSimilarity = 0.1, maxLinks = 4, dryRun = false } = options;

  const sections = await db.getAllSectionsWithEmbeddings(wikiId || null);
  const sectionsWithEmbeddings = sections.filter((s) => s.embedding);

  if (sectionsWithEmbeddings.length === 0) {
    return formatResponse({
      updated: 0,
      skipped: sections.length,
      dryRun: true,
      message: 'No sections with embeddings found. Run import_wiki first to generate embeddings.',
    });
  }

  const results = [];
  let updated = 0;
  let skipped = 0;

  for (const section of sectionsWithEmbeddings) {
    // Skip if already has outgoing links
    const existingLinks = await db.getOutgoingLinks(section.wikiId, section.key);
    if (existingLinks.length > 0) {
      skipped++;
      continue;
    }

    // Find similar sections
    const similar = await db.findSimilarSections(section.key, wikiId, maxLinks + 2);
    const filtered = similar.filter((s) => s.similarity >= minSimilarity).slice(0, maxLinks);

    if (filtered.length < 2) {
      skipped++;
      continue;
    }

    if (dryRun) {
      results.push({
        key: section.key,
        title: section.title,
        related: filtered.map((s) => ({ key: s.key, title: s.title, similarity: s.similarity })),
      });
    } else {
      let inserted = 0;
      for (const target of filtered) {
        const ok = await db.insertSectionLink(section.wikiId, section.key, target.wikiId, target.key);
        if (ok) inserted++;
      }
      if (inserted > 0) {
        updated++;
        results.push({
          key: section.key,
          title: section.title,
          related: filtered.map((s) => ({ key: s.key, title: s.title, similarity: s.similarity })),
        });
      } else {
        skipped++;
      }
    }
  }

  return formatResponse({
    wikiId: wikiId || 'all',
    updated,
    skipped,
    total: sectionsWithEmbeddings.length,
    dryRun,
    results: results.slice(0, 50),
    message: dryRun
      ? `Dry run: ${results.length} sections would get related links. Set dryRun=false to apply.`
      : `Inserted related links for ${updated} sections into section_links.`,
  });
}
