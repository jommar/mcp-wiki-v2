// src/service.js - Business logic layer
// Contains constants, validation, data transformation, and orchestration

import * as db from './db.js';
import * as wikiExport from './export.js';
import * as wikiImport from './import.js';
import { logger } from '../logger.js';
import { getEmbedding } from './embedding.js';
import { requestContext } from './context.js';

// Constants
export const MAX_BATCH_KEYS = 20;
export const MAX_BATCH_SECTIONS = 20;
export const BATCH_SIZE = 5;
export const MAX_CONTENT_LENGTH = 8000;
export const MAX_CONTENT_SIZE = 50000; // 50KB hard limit for writes
export const KEY_PATTERN = /^[a-z0-9-]+$/;
export const MAX_TITLE_LENGTH = 500;
export const MAX_PARENT_LENGTH = 255;
export const MAX_REASON_LENGTH = 100;

// Key validation
export function validateKey(key) {
  if (!key || !key.trim()) return 'Key cannot be empty';
  if (!KEY_PATTERN.test(key)) {
    return `Invalid key format: "${key}". Keys must be lowercase alphanumeric with hyphens`;
  }
  if (key.length > 255) return `Key too long (${key.length} chars, max 255)`;
  return null;
}

/** Validate a string field against a max-length constraint, returning an error message or null. */
export function validateField(name, value, maxLength) {
  if (
    value !== undefined &&
    value !== null &&
    typeof value === 'string' &&
    value.length > maxLength
  ) {
    return `${name} too long (${value.length} chars, max ${maxLength})`;
  }
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

// Debounce timestamps for auto-relink on read (key: "wikiId:sectionKey" → timestamp)
const serviceRelinkTimestamps = new Map();
const RELINK_DEBOUNCE_MS = parseInt(process.env.RELINK_DEBOUNCE_MS, 10) || 300_000;

export async function listWiki(wikiId, limit, offset = 0) {
  const sections = await db.listSections(wikiId || null, limit, offset);
  return formatResponse({ sections, count: sections.length });
}

export async function browseWiki(topic, wikiId, limit, offset = 0) {
  const sections = await db.browseSections(topic || null, wikiId || null, limit, offset);

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

export async function searchWiki(query, wikiId, parent, fuzzy, limit, offset = 0) {
  const results = await db.searchSections(query, {
    wikiId: wikiId || null,
    parent: parent || null,
    fuzzy,
    limit,
    offset,
  });

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

  // Fire-and-forget: track access; auto-link with debounce to prevent repeated
  // vector similarity searches on frequently-read orphan sections.
  db.incrementAccessCount(wikiId || section.wikiId, section.key).catch((err) =>
    logger.warn('Failed to increment access count', { key: section.key, error: err.message }),
  );
  if (relatedSections.length === 0) {
    const relinkKey = `${wikiId || section.wikiId}:${section.key}`;
    const lastRelink = serviceRelinkTimestamps.get(relinkKey);
    if (!lastRelink || Date.now() - lastRelink > RELINK_DEBOUNCE_MS) {
      serviceRelinkTimestamps.set(relinkKey, Date.now());
      db.relinkSection(wikiId || section.wikiId, section.key).catch((err) =>
        logger.warn('Failed to relink section', { key: section.key, error: err.message }),
      );
    }
  }

  let backlinks;
  let backlinksHasMore;
  if (includeBacklinks) {
    const result = await db.getBacklinks(key, wikiId || null);
    backlinks = result.backlinks;
    backlinksHasMore = !!result.hasMore;
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
    ...(includeBacklinks && { backlinks, backlinksHasMore }),
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

  // Fire-and-forget: track access and auto-link if section has no links yet
  for (const s of allSections) {
    if (!s.error) {
      db.incrementAccessCount(wikiId || s.wikiId, s.key).catch((err) =>
        logger.warn('Failed to increment access count', { key: s.key, error: err.message }),
      );
      db.relinkSection(wikiId || s.wikiId, s.key, { skipIfLinked: true }).catch((err) =>
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

export async function getBacklinks(key, wikiId, limit = 50) {
  const result = await db.getBacklinks(key, wikiId || null, limit);
  return formatResponse({ ...result, count: result.backlinks.length });
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
  if (keyError) throw new Error(keyError);

  if (!content || !content.trim()) throw new Error('Content cannot be empty');
  if (content.length > MAX_CONTENT_SIZE) {
    throw new Error(`Content too large (${content.length} chars, max ${MAX_CONTENT_SIZE})`);
  }
  if (title) {
    const titleErr = validateField('title', title, MAX_TITLE_LENGTH);
    if (titleErr) throw new Error(titleErr);
  }
  if (parent) {
    const parentErr = validateField('parent', parent, MAX_PARENT_LENGTH);
    if (parentErr) throw new Error(parentErr);
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

export async function createSections(wikiId, sections) {
  const created = [];
  const errors = [];

  // Phase 1: create in batches of BATCH_SIZE to reduce streaming window
  for (let i = 0; i < sections.length; i += BATCH_SIZE) {
    const batch = sections.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(async (s) => {
        const keyError = validateKey(s.key);
        if (keyError) throw new Error(keyError);
        if (!s.content || !s.content.trim()) throw new Error('Content cannot be empty');
        if (s.content.length > MAX_CONTENT_SIZE) {
          throw new Error(`Content too large (${s.content.length} chars, max ${MAX_CONTENT_SIZE})`);
        }
        const titleErr = validateField('title', s.title, MAX_TITLE_LENGTH);
        if (titleErr) throw new Error(titleErr);
        const parentErr = validateField('parent', s.parent, MAX_PARENT_LENGTH);
        if (parentErr) throw new Error(parentErr);

        const result = await db.createSection({
          wikiId,
          key: s.key,
          title: s.title,
          content: s.content,
          parent: s.parent || null,
          tags: s.tags || [],
          relatedKeys: s.relatedKeys || [],
          skipLink: true,
        });
        if (result && result.exists)
          throw new Error(`Section '${s.key}' already exists in ${wikiId}`);
        if (!result || !result.key) throw new Error(`Failed to create section '${s.key}'`);
        return result;
      }),
    );

    for (let j = 0; j < batch.length; j++) {
      const r = results[j];
      const s = batch[j];
      if (r.status === 'fulfilled') {
        created.push({ key: s.key, title: s.title, relatedKeys: s.relatedKeys || [] });
      } else {
        errors.push({ key: s.key, error: r.reason?.message ?? String(r.reason) });
      }
    }
  }

  // Phase 2: link all created sections in parallel — now they can all see each other
  // NOTE: Low-probability edge case — a concurrent auto_link_sections run between
  //       Phase 1 and Phase 2 could insert links that get overwritten. Since Phase 2
  //       replaces all links with the correct set (based on relatedKeys or embeddings),
  //       the final state is always correct. No lock needed. Decision: accepted race,
  //       minimal consequence (transient links lost, correct final state).
  await Promise.allSettled(
    created.map(({ key, relatedKeys }) =>
      relatedKeys.length > 0
        ? db.insertExplicitLinks(wikiId, key, relatedKeys)
        : db.relinkSection(wikiId, key),
    ),
  );

  return formatResponse({
    created: created.map(({ key, title }) => ({ key, wikiId, title })),
    errors,
    successCount: created.length,
    errorCount: errors.length,
  });
}

export async function updateSections(wikiId, updates) {
  const updated = [];
  const errors = [];

  // Process in batches of BATCH_SIZE to reduce streaming window
  for (let i = 0; i < updates.length; i += BATCH_SIZE) {
    const batch = updates.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(async (u) => {
        const keyError = validateKey(u.key);
        if (keyError) throw new Error(keyError);
        if (u.content !== undefined && u.content.length > MAX_CONTENT_SIZE) {
          throw new Error(`Content too large (${u.content.length} chars, max ${MAX_CONTENT_SIZE})`);
        }

        const hasChanges =
          u.content !== undefined ||
          u.title !== undefined ||
          u.parent !== undefined ||
          u.tags !== undefined ||
          u.relatedKeys !== undefined;
        if (!hasChanges) throw new Error('No fields provided to update');

        const titleErr = validateField('title', u.title, MAX_TITLE_LENGTH);
        if (titleErr) throw new Error(titleErr);
        const parentErr = validateField('parent', u.parent, MAX_PARENT_LENGTH);
        if (parentErr) throw new Error(parentErr);
        const reasonErr = validateField('reason', u.reason, MAX_REASON_LENGTH);
        if (reasonErr) throw new Error(reasonErr);

        const result = await db.updateSection({
          wikiId,
          key: u.key,
          content: u.content,
          title: u.title,
          parent: u.parent,
          tags: u.tags,
          reason: u.reason,
          relatedKeys: u.relatedKeys,
        });
        if (result && result.notFound) throw new Error(`Section '${u.key}' not found in ${wikiId}`);
        if (result && result.noChanges) throw new Error('No fields provided to update');
        if (!result || !result.key) throw new Error(`Failed to update section '${u.key}'`);
        return result;
      }),
    );

    for (let j = 0; j < batch.length; j++) {
      const r = results[j];
      const u = batch[j];
      if (r.status === 'fulfilled') {
        updated.push({ key: u.key, title: r.value.title });
      } else {
        errors.push({ key: u.key, error: r.reason?.message ?? String(r.reason) });
      }
    }
  }

  return formatResponse({
    updated: updated.map(({ key, title }) => ({ key, wikiId, title })),
    errors,
    successCount: updated.length,
    errorCount: errors.length,
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
  throw new Error(`Section '${key}' not found in ${wikiId}`);
}

// ─── IMPORT OPERATIONS ────────────────────────────────────────────────────────

export async function importWiki() {
  // Process all files in staging
  const ctx = requestContext.getStore();
  const pool = ctx?.pool;
  const result = await wikiImport.processStaging({ pool });

  // If any files were imported successfully, run auto-link for affected wikis
  if (result.success > 0) {
    logger.info('Running auto-link for all wikis after import');
    await autoLinkSections(null);
  }

  return formatResponse(result);
}

// ─── EXPORT OPERATIONS ────────────────────────────────────────────────────────

export async function exportWiki(outputDir, wikiId) {
  const ctx = requestContext.getStore();
  const pool = ctx?.pool;
  let results;
  if (wikiId) {
    const result = await wikiExport.exportWiki(wikiId, outputDir, { pool });
    results = [result];
  } else {
    results = await wikiExport.exportAllWikis(outputDir, { pool });
  }
  return formatResponse({ results });
}

// ─── AUTO-LINK OPERATIONS ─────────────────────────────────────────────────────

// Simple concurrency semaphore to cap parallel DB connections
export class Semaphore {
  constructor(max) {
    this.max = max;
    this.current = 0;
    this.queue = [];
  }
  acquire() {
    if (this.current < this.max) {
      this.current++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.queue.push(resolve));
  }
  release() {
    if (this.queue.length > 0) {
      this.queue.shift()();
    } else {
      this.current--;
    }
  }
  async run(fn) {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

async function processSectionLinks(section, wikiId, options) {
  const { minSimilarity, maxLinks, override, reembed } = options;

  // Regenerate embedding if requested
  if (reembed) {
    try {
      const embedding = await getEmbedding(`${section.title}\n${section.content.slice(0, 2000)}`);
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
  const {
    minSimilarity = 0.1,
    maxLinks = 4,
    override = false,
    parallel = true,
    reembed = false,
  } = options;

  const sections = await db.getAllSectionsWithEmbeddings(wikiId || null);
  const sectionsWithEmbeddings = sections.filter((s) => s.embedding);

  if (sectionsWithEmbeddings.length === 0) {
    logger.info('autoLinkSections: No sections with embeddings found.', { wikiId });
    return;
  }

  let updated = 0;
  let skipped = 0;

  if (parallel) {
    const MAX_CONCURRENCY = parseInt(process.env.AUTO_LINK_CONCURRENCY, 10) || 10;
    const sem = new Semaphore(MAX_CONCURRENCY);
    const results = await Promise.all(
      sectionsWithEmbeddings.map((section) =>
        sem
          .run(() =>
            processSectionLinks(section, wikiId, { minSimilarity, maxLinks, override, reembed }),
          )
          .catch((err) => {
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
