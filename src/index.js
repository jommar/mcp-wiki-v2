// src/index.js - MCP Server Controller
// Handles server setup, tool registration, and request routing

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { config } from 'dotenv';
import { logger } from '../logger.js';
import * as service from './service.js';
import { requestContext } from './context.js';
import * as db from './db.js';
import { drainAllPools } from './client-pool.js';

config();

// ─── WIKI ID RESOLUTION ──────────────────────────────────────────────────────
// If WIKI_ID env is set, wikiId is omitted from all tool schemas and resolved
// from the env value. If not set, wikiId is required so the agent must supply it.

const DEFAULT_WIKI_ID = process.env.WIKI_ID || null;

function wikiIdField() {
  if (DEFAULT_WIKI_ID) return {};
  return {
    wikiId: z.string().describe('Wiki instance ID (e.g., "user-wiki", "transact-wiki")'),
  };
}

function resolveWikiId(wikiId) {
  // Priority: authenticated API key (HTTP) > WIKI_ID env (stdio) > tool param
  const ctx = requestContext.getStore();
  if (ctx?.wikiId) return ctx.wikiId;
  if (DEFAULT_WIKI_ID) return DEFAULT_WIKI_ID;
  return wikiId || null;
}

const startedAt = Date.now();

const server = new McpServer({
  name: 'wiki-explorer-v2',
  version: '2.0.0',
});

// NOTE: Request counts are in-memory only (lost on restart). For production
//       observability, expose via /metrics endpoint or export to a time-series store.
const requestCounts = {
  list: 0,
  browse: 0,
  search: 0,
  get_section: 0,
  get_sections: 0,
  get_info: 0,
  create: 0,
  create_section: 0,
  create_sections: 0,
  update_section: 0,
  update_sections: 0,
  delete_section: 0,
  get_backlinks: 0,
  validate: 0,
  get_section_history: 0,
  auto_link_sections: 0,
  get_job_status: 0,
  import: 0,
  export: 0,
};

// Track background tasks for graceful shutdown and status polling
const backgroundTasks = new Map(); // wikiId -> Promise
const jobStatuses = new Map(); // jobId -> { wikiId, status, startedAt, completedAt, error }
let jobCounter = 0;

const readOnlyAnnotations = { readOnlyHint: true };

const sectionRefSchema = {
  key: z.string().describe('Canonical slug key for the section'),
  parent: z.string().describe('Parent topic/group name'),
  title: z.string().describe('Display title of the section'),
  breadcrumbs: z.array(z.string()).describe('Heading hierarchy from root to parent'),
};

// ─── READ TOOLS ──────────────────────────────────────────────────────────────

server.registerTool(
  'list',
  {
    description: 'List all available section keys. Use browse instead for topic-filtered results.',
    inputSchema: {
      ...wikiIdField(),
      limit: z
        .number()
        .optional()
        .default(100)
        .describe('Maximum sections to return (default 100)'),
      offset: z
        .number()
        .optional()
        .default(0)
        .describe('Number of sections to skip (for pagination)'),
    },
    outputSchema: {
      sections: z
        .array(
          z.object({
            ...sectionRefSchema,
            wikiId: z.string().describe('Wiki instance ID'),
            tags: z.array(z.string()).describe('Tags for categorization'),
            contentLength: z.number().describe('Content length in characters'),
            linkCount: z.number().describe('Number of outgoing section links'),
          }),
        )
        .describe('All wiki sections'),
      count: z.number().describe('Total number of sections'),
      error: z.string().optional().describe('Error message if request failed'),
    },
    annotations: readOnlyAnnotations,
  },
  async ({ wikiId, limit, offset }) => {
    try {
      requestCounts.list++;
      logger.info('list', { wikiId, limit, offset });
      return await service.listWiki(resolveWikiId(wikiId), limit, offset || 0);
    } catch (err) {
      logger.error('list failed', { error: err.message });
      return service.formatResponse({ sections: [], count: 0, error: err.message });
    }
  },
);

server.registerTool(
  'browse',
  {
    description:
      'Browse sections by topic/parent. Returns section keys and titles without full content.',
    inputSchema: {
      topic: z
        .string()
        .optional()
        .describe(
          'Filter by parent topic (e.g., "Portage Backend", "Approval Workflow Deep Dive")',
        ),
      ...wikiIdField(),
      limit: z
        .number()
        .optional()
        .default(100)
        .describe('Maximum sections to return (default 100)'),
      offset: z
        .number()
        .optional()
        .default(0)
        .describe('Number of sections to skip (for pagination)'),
    },
    outputSchema: {
      groups: z
        .array(
          z.object({
            parent: z.string().describe('Parent topic name'),
            sections: z.array(
              z.object({
                key: z.string().describe('Canonical slug key'),
                wikiId: z.string().describe('Wiki instance ID'),
                title: z.string().describe('Display title'),
                depth: z.number().describe('Heading depth (2 = H2, 3 = H3, etc.)'),
                breadcrumbs: z.array(z.string()).describe('Heading hierarchy from root to parent'),
              }),
            ),
          }),
        )
        .describe('Sections grouped by parent topic'),
      count: z.number().describe('Total number of matching sections'),
      error: z.string().optional().describe('Error message if request failed'),
    },
    annotations: readOnlyAnnotations,
  },
  async ({ topic, wikiId, limit, offset }) => {
    try {
      requestCounts.browse++;
      logger.info('browse', { topic, wikiId, limit, offset });
      return await service.browseWiki(topic, resolveWikiId(wikiId), limit, offset || 0);
    } catch (err) {
      logger.error('browse failed', { topic, wikiId, error: err.message });
      return service.formatResponse({ groups: [], count: 0, error: err.message });
    }
  },
);

server.registerTool(
  'search',
  {
    description:
      'Search sections by meaning (semantic search). Falls back to keyword matching if embeddings are unavailable. Returns matching section keys ranked by relevance.',
    inputSchema: {
      query: z
        .string()
        .min(1)
        .max(200)
        .describe('Search query — can be natural language or keywords'),
      parent: z.string().optional().describe('Filter by parent topic (e.g., "Portage Backend")'),
      ...wikiIdField(),
      fuzzy: z.boolean().optional().default(false).describe('Enable fuzzy matching for typos'),
      limit: z.number().optional().default(20).describe('Maximum number of results to return'),
      offset: z
        .number()
        .optional()
        .default(0)
        .describe('Number of results to skip (for pagination)'),
    },
    outputSchema: {
      results: z
        .array(
          z.object({
            ...sectionRefSchema,
            wikiId: z.string().describe('Wiki instance ID'),
            snippet: z.string().optional().describe('Short content excerpt around the match'),
          }),
        )
        .describe('Matching sections, header matches first'),
      count: z.number().describe('Number of results'),
      suggestions: z
        .array(z.object({ key: z.string(), wikiId: z.string() }))
        .optional()
        .describe('Similar sections when no results found'),
      error: z.string().optional().describe('Error message if request failed'),
    },
    annotations: readOnlyAnnotations,
  },
  async ({ query, wikiId, parent, fuzzy, limit, offset }) => {
    try {
      requestCounts.search++;
      logger.info('search', { query, wikiId, parent, fuzzy, limit, offset });
      return await service.searchWiki(
        query,
        resolveWikiId(wikiId),
        parent,
        fuzzy,
        limit,
        offset || 0,
      );
    } catch (err) {
      logger.error('search failed', { query, error: err.message });
      return service.formatResponse({ results: [], count: 0, error: err.message });
    }
  },
);

server.registerTool(
  'get_section',
  {
    description: `Retrieve markdown content of a section. Defaults to ${service.MAX_CONTENT_LENGTH} chars to save tokens. Set limit higher or use offset to read the full section.`,
    inputSchema: {
      key: z
        .string()
        .describe("The unique slug key of the section (e.g., 'portage-backend-architecture')"),
      ...wikiIdField(),
      offset: z
        .number()
        .optional()
        .default(0)
        .describe('Character offset to start from. Use to paginate through large sections.'),
      limit: z
        .number()
        .optional()
        .default(service.MAX_CONTENT_LENGTH)
        .describe(`Max characters to return. Default is ${service.MAX_CONTENT_LENGTH}.`),
      includeBacklinks: z
        .boolean()
        .optional()
        .default(false)
        .describe('If true, also include backlinks in the response'),
    },
    outputSchema: {
      key: z.string().optional().describe('Section slug key'),
      title: z.string().optional().describe('Section display title'),
      parent: z.string().optional().describe('Parent topic name'),
      breadcrumbs: z.array(z.string()).optional().describe('Heading hierarchy from root to parent'),
      wikiId: z.string().optional().describe('Wiki instance ID'),
      source: z.string().optional().describe('Source file path'),
      content: z.string().optional().describe('Section markdown content'),
      totalLength: z.number().optional().describe('Total content length in characters'),
      offset: z.number().optional().describe('Current character offset'),
      limit: z.number().optional().describe('Applied character limit'),
      hasMore: z.boolean().optional().describe('Whether more content exists beyond this page'),
      nextOffset: z.number().optional().describe('Offset for the next page, if hasMore is true'),
      updatedAt: z
        .string()
        .nullable()
        .optional()
        .describe('ISO 8601 timestamp of the last update, or null if unknown'),
      relatedSections: z
        .array(
          z.object({
            key: z.string().describe('Related section key'),
            title: z.string().describe('Related section title'),
          }),
        )
        .optional()
        .describe('Outgoing links from this section (embedding-based, set by auto-link)'),
      backlinks: z
        .array(
          z.object({
            key: z.string().describe('Backlink section key'),
            wikiId: z.string().describe('Wiki instance ID'),
            title: z.string().describe('Backlink section title'),
            parent: z.string().describe('Parent topic name'),
          }),
        )
        .optional()
        .describe('Sections that link to this section'),
      backlinksHasMore: z
        .boolean()
        .optional()
        .describe('True if more backlinks exist beyond the returned list'),
      error: z.string().optional().describe('Error message if section not found or key invalid'),
      suggestions: z.array(z.string()).optional().describe('Similar keys when section not found'),
    },
    annotations: readOnlyAnnotations,
  },
  async ({ key, wikiId, offset, limit, includeBacklinks }) => {
    try {
      requestCounts.get_section++;
      logger.info('get_section', { key, wikiId, offset, limit, includeBacklinks });
      return await service.getWikiSection(
        key,
        resolveWikiId(wikiId),
        offset,
        limit,
        includeBacklinks,
      );
    } catch (err) {
      logger.error('get_section failed', { key, error: err.message });
      return service.formatResponse({ error: err.message });
    }
  },
);

server.registerTool(
  'get_sections',
  {
    description: 'Retrieve multiple sections at once. Each section is truncated to save tokens.',
    inputSchema: {
      keys: z
        .array(z.string())
        .min(1)
        .max(service.MAX_BATCH_KEYS)
        .describe(`Array of section slug keys to retrieve (max ${service.MAX_BATCH_KEYS})`),
      ...wikiIdField(),
    },
    outputSchema: {
      sections: z
        .array(
          z.union([
            z.object({
              key: z.string().describe('Section slug key'),
              wikiId: z.string().describe('Wiki instance ID'),
              title: z.string().describe('Section display title'),
              parent: z.string().describe('Parent topic name'),
              breadcrumbs: z.array(z.string()).describe('Heading hierarchy from root to parent'),
              source: z.string().describe('Source file path'),
              content: z.string().describe('Section markdown content'),
              truncated: z.boolean().describe('Whether content was truncated'),
              totalLength: z
                .number()
                .optional()
                .describe('Total content length (present when truncated)'),
              updatedAt: z
                .string()
                .nullable()
                .optional()
                .describe('ISO 8601 timestamp of the last update, or null if unknown'),
            }),
            z.object({
              key: z.string().describe('Requested section slug key'),
              error: z.string().describe('Error message'),
            }),
          ]),
        )
        .describe('Retrieved sections; error field present if section not found'),
      successCount: z.number().describe('Number of successfully retrieved sections'),
      errorCount: z.number().describe('Number of sections that failed'),
      error: z.string().optional().describe('Error message if request failed'),
    },
    annotations: readOnlyAnnotations,
  },
  async ({ keys, wikiId }) => {
    try {
      requestCounts.get_sections++;
      logger.info('get_sections', { keys, wikiId });
      return await service.getWikiSections(keys, resolveWikiId(wikiId));
    } catch (err) {
      logger.error('get_sections failed', { keys, error: err.message });
      return service.formatResponse({
        sections: [],
        successCount: 0,
        errorCount: keys.length,
        error: err.message,
      });
    }
  },
);

server.registerTool(
  'get_info',
  {
    description:
      'Get metadata about connected instances — instance IDs, section counts, and server uptime.',
    inputSchema: {
      ...wikiIdField(),
    },
    outputSchema: {
      wikis: z
        .array(
          z.object({
            wikiId: z.string().describe('Wiki instance ID'),
            sectionCount: z.number().describe('Number of sections'),
          }),
        )
        .describe('Wiki instances and their section counts'),
      uptime: z.number().describe('Server uptime in seconds'),
      error: z.string().optional().describe('Error message if request failed'),
    },
    annotations: readOnlyAnnotations,
  },
  async ({ wikiId }) => {
    try {
      requestCounts.get_info++;
      const result = await service.getWikiInfo(resolveWikiId(wikiId));
      // Add uptime to the response
      result.structuredContent.uptime = (Date.now() - startedAt) / 1000;
      result.content[0].text = JSON.stringify(result.structuredContent, null, 2);
      logger.info('get_info', { wikiId });
      return result;
    } catch (err) {
      logger.error('get_info failed', { error: err.message });
      return service.formatResponse({ wikis: [], uptime: 0, error: err.message });
    }
  },
);

// ─── NEW TOOLS ───────────────────────────────────────────────────────────────

server.registerTool(
  'get_backlinks',
  {
    description: 'Find all wiki sections that link to a given section (backlinks).',
    inputSchema: {
      key: z.string().describe('The section key to find backlinks for'),
      ...wikiIdField(),
      limit: z.number().optional().default(50).describe('Maximum backlinks to return (default 50)'),
    },
    outputSchema: {
      backlinks: z
        .array(
          z.object({
            key: z.string().describe('Section that links here'),
            wikiId: z.string().describe('Wiki instance of the linking section'),
            title: z.string().describe('Title of the linking section'),
            parent: z.string().describe('Parent topic of the linking section'),
          }),
        )
        .describe('Sections that reference this one'),
      count: z.number().describe('Number of backlinks returned'),
      hasMore: z.boolean().describe('True if more backlinks exist beyond this limit'),
      error: z.string().optional().describe('Error message if request failed'),
    },
    annotations: readOnlyAnnotations,
  },
  async ({ key, wikiId, limit }) => {
    try {
      requestCounts.get_backlinks++;
      logger.info('get_backlinks', { key, wikiId, limit });
      return await service.getBacklinks(key, resolveWikiId(wikiId), limit);
    } catch (err) {
      logger.error('get_backlinks failed', { key, error: err.message });
      return service.formatResponse({
        backlinks: [],
        count: 0,
        hasMore: false,
        error: err.message,
      });
    }
  },
);

server.registerTool(
  'validate',
  {
    description:
      'Run validation checks on sections — finds empty sections, orphaned sections, and unlinked sections.',
    inputSchema: {
      ...wikiIdField(),
    },
    outputSchema: {
      healthy: z.boolean().describe('True if no issues found'),
      emptySectionsCount: z.number().describe('Number of sections with no content'),
      orphanedSectionsCount: z
        .number()
        .describe('Number of sections with no parent, children, or backlinks'),
      unlinkedSectionsCount: z
        .number()
        .describe('Number of sections not linked from any other section'),
      error: z.string().optional().describe('Error message if request failed'),
    },
    annotations: readOnlyAnnotations,
  },
  async ({ wikiId }) => {
    try {
      requestCounts.validate++;
      logger.info('validate', { wikiId });
      return await service.validateWiki(resolveWikiId(wikiId));
    } catch (err) {
      logger.error('validate failed', { error: err.message });
      return service.formatResponse({
        healthy: false,
        emptySectionsCount: 0,
        orphanedSectionsCount: 0,
        unlinkedSectionsCount: 0,
        error: err.message,
      });
    }
  },
);

server.registerTool(
  'get_section_history',
  {
    description: 'Get the edit history of a wiki section.',
    inputSchema: {
      key: z.string().describe('The section key'),
      ...wikiIdField(),
      limit: z.number().optional().default(10).describe('Number of history entries to return'),
    },
    outputSchema: {
      history: z
        .array(
          z.object({
            contentBefore: z.string().optional().describe('Content before the change'),
            contentAfter: z.string().describe('Content after the change'),
            changedAt: z.string().describe('ISO timestamp of the change'),
            changeReason: z.string().optional().describe('Reason for the change'),
          }),
        )
        .describe('Edit history entries'),
      count: z.number().describe('Number of history entries'),
      error: z.string().optional().describe('Error message if request failed'),
    },
    annotations: readOnlyAnnotations,
  },
  async ({ key, wikiId, limit }) => {
    try {
      requestCounts.get_section_history++;
      logger.info('get_section_history', { key, wikiId, limit });
      return await service.getSectionHistory(resolveWikiId(wikiId), key, limit);
    } catch (err) {
      logger.error('get_section_history failed', { key, wikiId, error: err.message });
      return service.formatResponse({ history: [], count: 0, error: err.message });
    }
  },
);

// ─── WRITE TOOLS ─────────────────────────────────────────────────────────────

server.registerTool(
  'create',
  {
    description:
      'Create a new root-level section with no parent. Use this to initialize a new instance or create a top-level entry point. For nested content under an existing topic, use create_sections instead.',
    inputSchema: {
      ...wikiIdField(),
      key: z.string().describe('Unique slug key (lowercase alphanumeric with hyphens)'),
      title: z.string().describe('Display title for the wiki or root topic'),
      content: z
        .string()
        .describe(
          'Overview or description of this wiki — what it covers, its purpose, and key areas. Keep it concise (3–4 sentences max).',
        ),
      tags: z.array(z.string()).optional().describe('Tags for categorization'),
      relatedKeys: z
        .array(z.string())
        .optional()
        .describe('Section keys to link to from this root section'),
    },
    outputSchema: {
      key: z.string().optional().describe('Created section key'),
      wikiId: z.string().optional().describe('Wiki instance ID'),
      title: z.string().optional().describe('Section title'),
      created: z.boolean().describe('Whether the wiki section was created'),
      error: z.string().optional().describe('Error message if creation failed'),
    },
  },
  async ({ wikiId, key, title, content, tags, relatedKeys }) => {
    try {
      requestCounts.create++;
      logger.info('create', { wikiId, key, title });
      return await service.createSection(
        resolveWikiId(wikiId),
        key,
        title,
        content,
        null,
        tags,
        relatedKeys,
      );
    } catch (err) {
      logger.error('create failed', { key, error: err.message });
      return service.formatResponse({ created: false, error: err.message });
    }
  },
);

server.registerTool(
  'create_sections',
  {
    description:
      'Create multiple wiki sections at once. All sections are created and embedded in parallel, then linked in a second parallel pass — so newly created sections can link to each other. Use instead of multiple create_section calls when adding several related sections.',
    inputSchema: {
      ...wikiIdField(),
      sections: z
        .array(
          z.object({
            key: z.string().describe('Unique slug key (lowercase alphanumeric with hyphens)'),
            title: z.string().describe('Display title'),
            content: z
              .string()
              .describe('Markdown content. Keep bite-sized: 3–4 bullets or sentences max.'),
            parent: z.string().describe('Parent topic name'),
            tags: z.array(z.string()).optional().describe('Tags for categorization'),
            relatedKeys: z.array(z.string()).optional().describe('Explicit links for this section'),
          }),
        )
        .min(1)
        .max(service.MAX_BATCH_SECTIONS)
        .describe(`Array of sections to create (max ${service.MAX_BATCH_SECTIONS})`),
    },
    outputSchema: {
      created: z
        .array(z.object({ key: z.string(), wikiId: z.string(), title: z.string() }))
        .describe('Successfully created sections'),
      errors: z
        .array(z.object({ key: z.string(), error: z.string() }))
        .describe('Sections that failed to create'),
      successCount: z.number().describe('Number of sections created'),
      errorCount: z.number().describe('Number of sections that failed'),
    },
  },
  async ({ wikiId, sections }) => {
    try {
      requestCounts.create_sections++;
      logger.info('create_sections', { wikiId, count: sections.length });
      return await service.createSections(resolveWikiId(wikiId), sections);
    } catch (err) {
      logger.error('create_sections failed', { wikiId, error: err.message });
      return service.formatResponse({
        created: [],
        errors: [],
        successCount: 0,
        errorCount: sections.length,
      });
    }
  },
);

server.registerTool(
  'update_sections',
  {
    description:
      'Update multiple wiki sections at once. Only provide fields you want to change per section. At least one of content, title, parent, tags, or relatedKeys must be provided per entry. Use instead of multiple update_section calls for batch maintenance.',
    inputSchema: {
      ...wikiIdField(),
      updates: z
        .array(
          z.object({
            key: z.string().describe('Section key to update'),
            content: z.string().optional().describe('New markdown content'),
            title: z.string().optional().describe('New display title'),
            parent: z.string().optional().describe('New parent topic'),
            tags: z.array(z.string()).optional().describe('New tags'),
            reason: z.string().optional().describe('Reason for the change (recorded in history)'),
            relatedKeys: z
              .array(z.string())
              .optional()
              .describe('Replace outgoing links with these section keys'),
          }),
        )
        .min(1)
        .max(service.MAX_BATCH_SECTIONS)
        .describe(`Array of section updates (max ${service.MAX_BATCH_SECTIONS})`),
    },
    outputSchema: {
      updated: z
        .array(z.object({ key: z.string(), wikiId: z.string(), title: z.string() }))
        .describe('Successfully updated sections'),
      errors: z
        .array(z.object({ key: z.string(), error: z.string() }))
        .describe('Sections that failed to update'),
      successCount: z.number().describe('Number of sections updated'),
      errorCount: z.number().describe('Number of sections that failed'),
    },
  },
  async ({ wikiId, updates }) => {
    try {
      requestCounts.update_sections = (requestCounts.update_sections || 0) + 1;
      logger.info('update_sections', { wikiId, count: updates.length });
      return await service.updateSections(resolveWikiId(wikiId), updates);
    } catch (err) {
      logger.error('update_sections failed', { wikiId, error: err.message });
      return service.formatResponse({
        updated: [],
        errors: [],
        successCount: 0,
        errorCount: updates.length,
      });
    }
  },
);

server.registerTool(
  'delete_section',
  {
    description:
      'Delete a wiki section. This also removes all backlinks to/from this section. Run get_backlinks first to see what links here before deleting.',
    inputSchema: {
      ...wikiIdField(),
      key: z.string().describe('Section key to delete'),
    },
    outputSchema: {
      key: z.string().optional().describe('Deleted section key'),
      wikiId: z.string().optional().describe('Wiki instance ID'),
      title: z.string().optional().describe('Deleted section title'),
      deleted: z.boolean().describe('Whether the section was deleted'),
      error: z.string().optional().describe('Error message if deletion failed'),
    },
    annotations: { destructiveHint: true },
  },
  async ({ wikiId, key }) => {
    try {
      requestCounts.delete_section++;
      logger.info('delete_section', { wikiId, key });
      return await service.deleteSection(resolveWikiId(wikiId), key);
    } catch (err) {
      logger.error('delete_section failed', { key, error: err.message });
      return service.formatResponse({ deleted: false, error: err.message });
    }
  },
);

// ─── AUTO-LINK TOOL ──────────────────────────────────────────────────────────

server.registerTool(
  'auto_link_sections',
  {
    description:
      'Automatically find related sections using vector embeddings and link sections that lack them. Uses cosine similarity on stored embeddings. Runs in the background — returns a jobId for status polling. Only one run per wiki is allowed at a time; calling again while in progress returns an error.',
    inputSchema: {
      ...wikiIdField(),
      minSimilarity: z
        .number()
        .optional()
        .default(0.1)
        .describe('Minimum cosine similarity threshold (0-1, default 0.1)'),
      maxLinks: z
        .number()
        .optional()
        .default(4)
        .describe('Maximum number of related links per section (default 4)'),
      override: z
        .boolean()
        .optional()
        .default(false)
        .describe('Re-link sections that already have links'),
      reembed: z
        .boolean()
        .optional()
        .default(false)
        .describe('Regenerate embeddings before linking'),
      parallel: z
        .boolean()
        .optional()
        .default(true)
        .describe('Process sections in parallel (default: true)'),
    },
    outputSchema: z.object({
      jobId: z.string().optional().describe('Job ID for status polling via get_job_status'),
      message: z.string().optional().describe('Status message'),
      error: z.string().optional().describe('Error message if request failed'),
    }),
  },
  ({ wikiId, minSimilarity, maxLinks, override, reembed, parallel }) => {
    try {
      const resolvedWikiId = resolveWikiId(wikiId);
      requestCounts.auto_link_sections = (requestCounts.auto_link_sections || 0) + 1;
      logger.info('auto_link_sections', {
        wikiId: resolvedWikiId,
        minSimilarity,
        maxLinks,
        override,
        reembed,
        parallel,
      });

      // If already running for this wiki, reject
      const taskKey = resolvedWikiId || 'default';
      if (backgroundTasks.has(taskKey)) {
        return service.formatResponse({
          message: '',
          error: `Auto-linking already in progress for ${taskKey}. Wait for it to complete.`,
        });
      }

      const jobId = `job-${++jobCounter}`;
      const startedAt = new Date().toISOString();

      // Register job status
      jobStatuses.set(jobId, { wikiId: resolvedWikiId, status: 'running', startedAt });

      // Run in background and track for shutdown
      const task = service.autoLinkSections(resolvedWikiId, {
        minSimilarity,
        maxLinks,
        override,
        reembed,
        parallel,
      });
      backgroundTasks.set(taskKey, task);
      task
        .then(() => {
          logger.info('auto_link_sections completed', { wikiId: resolvedWikiId, jobId });
          const job = jobStatuses.get(jobId);
          if (job) {
            job.status = 'completed';
            job.completedAt = new Date().toISOString();
          }
        })
        .catch((err) => {
          logger.error('auto_link_sections failed (background)', {
            wikiId: resolvedWikiId,
            jobId,
            error: err.message,
          });
          const job = jobStatuses.get(jobId);
          if (job) {
            job.status = 'failed';
            job.error = err.message;
            job.completedAt = new Date().toISOString();
          }
        })
        .finally(() => {
          backgroundTasks.delete(taskKey);
          setTimeout(() => jobStatuses.delete(jobId), 60 * 60 * 1000);
        });

      return service.formatResponse({
        jobId,
        message: 'Auto-linking is running in the background. Poll status with get_job_status.',
      });
    } catch (err) {
      logger.error('auto_link_sections failed', { wikiId, error: err.message });
      return service.formatResponse({
        message: '',
        error: err.message,
      });
    }
  },
);

server.registerTool(
  'get_job_status',
  {
    description:
      'Check the status of a background job (e.g., auto_link_sections). Returns running, completed, or failed.',
    inputSchema: {
      jobId: z.string().describe('Job ID returned by auto_link_sections'),
    },
    outputSchema: z.object({
      jobId: z.string().describe('Job ID'),
      wikiId: z.string().optional().describe('Wiki instance ID'),
      status: z
        .enum(['running', 'completed', 'failed', 'not_found'])
        .describe('Current job status'),
      startedAt: z.string().optional().describe('ISO timestamp when job started'),
      completedAt: z.string().optional().describe('ISO timestamp when job completed or failed'),
      error: z.string().optional().describe('Error message if job failed'),
    }),
    annotations: readOnlyAnnotations,
  },
  ({ jobId }) => {
    try {
      requestCounts.get_job_status = (requestCounts.get_job_status || 0) + 1;
      logger.info('get_job_status', { jobId });
      const job = jobStatuses.get(jobId);
      if (!job) {
        return service.formatResponse({ jobId, status: 'not_found' });
      }
      return service.formatResponse({
        jobId,
        wikiId: job.wikiId,
        status: job.status,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
        error: job.error,
      });
    } catch (err) {
      logger.error('get_job_status failed', { jobId, error: err.message });
      return service.formatResponse({ jobId, status: 'not_found', error: err.message });
    }
  },
);

// ─── IMPORT TOOL ─────────────────────────────────────────────────────────────

server.registerTool(
  'import',
  {
    description:
      'Import markdown files from import/staging into the database. Files must have YAML frontmatter with key, parent, and title. Successful imports move to import/success, failures to import/fail. Auto-linking runs automatically after import.',
    inputSchema: {},
    outputSchema: {
      total: z.number().describe('Total files processed from staging'),
      success: z.number().describe('Number of files successfully imported'),
      failed: z.number().describe('Number of files that failed to import'),
      errors: z
        .array(z.object({ file: z.string(), error: z.string() }))
        .describe('Details of failed imports'),
      error: z.string().optional().describe('Error message if import failed entirely'),
    },
  },
  async () => {
    try {
      requestCounts.import = (requestCounts.import || 0) + 1;
      logger.info('import');
      return await service.importWiki();
    } catch (err) {
      logger.error('import failed', { error: err.message });
      return service.formatResponse({
        total: 0,
        success: 0,
        failed: 0,
        errors: [],
        error: err.message,
      });
    }
  },
);

// ─── EXPORT TOOL ─────────────────────────────────────────────────────────────

server.registerTool(
  'export',
  {
    description:
      'Export sections to markdown files. Exports from all instances by default, or from a specific instance if wikiId is provided.',
    inputSchema: {
      outputDir: z.string().describe('Directory to write exported markdown files to'),
      ...wikiIdField(),
    },
    outputSchema: {
      results: z
        .array(
          z.object({
            wikiId: z.string().describe('Wiki instance ID'),
            exported: z.number().describe('Number of sections exported'),
            filePath: z
              .string()
              .nullable()
              .describe('Path to the exported file (null if no sections)'),
          }),
        )
        .describe('Export results per wiki'),
      error: z.string().optional().describe('Error message if export failed'),
    },
  },
  async ({ outputDir, wikiId }) => {
    try {
      requestCounts.export = (requestCounts.export || 0) + 1;
      logger.info('export', { outputDir, wikiId });
      return await service.exportWiki(outputDir, resolveWikiId(wikiId));
    } catch (err) {
      logger.error('export failed', { outputDir, error: err.message });
      return service.formatResponse({ results: [], error: err.message });
    }
  },
);

// ─── SHUTDOWN ────────────────────────────────────────────────────────────────

let httpServer = null;

async function shutdown() {
  const uptimeSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  const totalRequests = Object.values(requestCounts).reduce((a, b) => a + b, 0);
  const activeTools = Object.entries(requestCounts)
    .filter(([, count]) => count > 0)
    .map(([name, count]) => `${name}:${count}`)
    .join(', ');

  logger.info('Shutting down', {
    uptime: `${uptimeSec}s`,
    totalRequests,
    tools: activeTools || 'none',
  });

  // Drain HTTP connections before closing
  if (httpServer) {
    httpServer.closeIdleConnections?.();
    await new Promise((resolve) => httpServer.close(resolve));
    logger.info('HTTP server closed');
  }

  // Wait for all background tasks if running
  if (backgroundTasks.size > 0) {
    logger.info(`Waiting for ${backgroundTasks.size} background task(s)...`);
    await Promise.all(backgroundTasks.values());
  }

  await db.pool.end();
  await drainAllPools();
  logger.close().then(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', () => {
  const uptimeSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  const totalRequests = Object.values(requestCounts).reduce((a, b) => a + b, 0);
  const activeTools = Object.entries(requestCounts)
    .filter(([, count]) => count > 0)
    .map(([name, count]) => `${name}:${count}`)
    .join(', ');

  logger.flushSync('info', 'Shutting down', {
    uptime: `${uptimeSec}s`,
    totalRequests,
    tools: activeTools || 'none',
  });
});
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { error: err.message, stack: err.stack });
  shutdown();
});
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', { reason: String(reason) });
  shutdown();
});

import { runMigrations } from './migrate.js';
import { connect } from './transport.js';
import { ensureDatabase } from './ensure-db.js';

logger.info('Starting Wiki Explorer V2 MCP Server', {
  dbHost: process.env.DB_HOST || 'localhost',
  dbPort: process.env.DB_PORT || '5433',
  pid: process.pid,
  node: process.version,
});

// Startup health checks
if (process.env.TRANSPORT === 'http') {
  logger.warn(
    'HTTP mode: run behind a TLS-terminating reverse proxy (nginx, Caddy) for production.',
  );
}

// In stdio mode, auto-create the database so migrations can run.
// HTTP mode doesn't need this — the admin DB is separate, and client DBs
// are created on-demand via client-pool.js.
await ensureDatabase();
await runMigrations();
httpServer = await connect(server);
