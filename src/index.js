// src/index.js - MCP Server Controller
// Handles server setup, tool registration, and request routing

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { config } from 'dotenv';
import { logger } from '../logger.js';
import * as service from './service.js';

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
  if (DEFAULT_WIKI_ID) return DEFAULT_WIKI_ID;
  return wikiId || null;
}

const startedAt = Date.now();

const server = new McpServer({
  name: 'wiki-explorer-v2',
  version: '2.0.0',
});

const requestCounts = {
  list_wiki: 0,
  browse_wiki: 0,
  search_wiki: 0,
  get_wiki_section: 0,
  get_wiki_sections: 0,
  get_wiki_info: 0,
  create_wiki: 0,
  create_section: 0,
  create_sections: 0,
  update_section: 0,
  delete_section: 0,
  get_backlinks: 0,
  validate_wiki: 0,
  get_section_history: 0,
  auto_link_sections: 0,
  import_wiki: 0,
  export_wiki: 0,
};

// Track background tasks for graceful shutdown
const backgroundTasks = new Map(); // wikiId -> Promise

const readOnlyAnnotations = { readOnlyHint: true };

const sectionRefSchema = {
  key: z.string().describe('Canonical slug key for the section'),
  parent: z.string().describe('Parent topic/group name'),
  title: z.string().describe('Display title of the section'),
  breadcrumbs: z.array(z.string()).describe('Heading hierarchy from root to parent'),
};

// ─── READ TOOLS ──────────────────────────────────────────────────────────────

server.registerTool(
  'list_wiki',
  {
    description:
      'List all available wiki section keys. Use browse_wiki instead for topic-filtered results.',
    inputSchema: {
      ...wikiIdField(),
      limit: z
        .number()
        .optional()
        .default(100)
        .describe('Maximum sections to return (default 100)'),
    },
    outputSchema: {
      sections: z
        .array(
          z.object({
            ...sectionRefSchema,
            wikiId: z.string().describe('Wiki instance ID'),
            contentLength: z.number().describe('Content length in characters'),
          }),
        )
        .describe('All wiki sections'),
      count: z.number().describe('Total number of sections'),
      error: z.string().optional().describe('Error message if request failed'),
    },
    annotations: readOnlyAnnotations,
  },
  async ({ wikiId, limit }) => {
    try {
      requestCounts.list_wiki++;
      logger.info('list_wiki', { wikiId, limit });
      return await service.listWiki(resolveWikiId(wikiId), limit);
    } catch (err) {
      logger.error('list_wiki failed', { error: err.message });
      return service.formatResponse({ sections: [], count: 0, error: err.message });
    }
  },
);

server.registerTool(
  'browse_wiki',
  {
    description:
      'Browse wiki sections by topic/parent. Returns section keys and titles without full content.',
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
  async ({ topic, wikiId, limit }) => {
    try {
      requestCounts.browse_wiki++;
      logger.info('browse_wiki', { topic, wikiId, limit });
      return await service.browseWiki(topic, resolveWikiId(wikiId), limit);
    } catch (err) {
      logger.error('browse_wiki failed', { topic, wikiId, error: err.message });
      return service.formatResponse({ groups: [], count: 0, error: err.message });
    }
  },
);

server.registerTool(
  'search_wiki',
  {
    description:
      'Search wiki sections by meaning (semantic search). Falls back to keyword matching if embeddings are unavailable. Returns matching section keys ranked by relevance.',
    inputSchema: {
      query: z
        .string()
        .min(1)
        .max(200)
        .describe('Search query — can be natural language or keywords'),
      ...wikiIdField(),
      fuzzy: z.boolean().optional().default(false).describe('Enable fuzzy matching for typos'),
      limit: z.number().optional().default(20).describe('Maximum number of results to return'),
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
  async ({ query, wikiId, fuzzy, limit }) => {
    try {
      requestCounts.search_wiki++;
      logger.info('search_wiki', { query, wikiId, fuzzy, limit });
      return await service.searchWiki(query, resolveWikiId(wikiId), fuzzy, limit);
    } catch (err) {
      logger.error('search_wiki failed', { query, error: err.message });
      return service.formatResponse({ results: [], count: 0, error: err.message });
    }
  },
);

server.registerTool(
  'get_wiki_section',
  {
    description: `Retrieve markdown content of a wiki section. Defaults to ${service.MAX_CONTENT_LENGTH} chars to save tokens. Set limit higher or use offset to read the full section.`,
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
      updatedAt: z.string().nullable().optional().describe('ISO 8601 timestamp of the last update, or null if unknown'),
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
      error: z.string().optional().describe('Error message if section not found or key invalid'),
      suggestions: z.array(z.string()).optional().describe('Similar keys when section not found'),
    },
    annotations: readOnlyAnnotations,
  },
  async ({ key, wikiId, offset, limit, includeBacklinks }) => {
    try {
      requestCounts.get_wiki_section++;
      logger.info('get_wiki_section', { key, wikiId, offset, limit, includeBacklinks });
      return await service.getWikiSection(key, resolveWikiId(wikiId), offset, limit, includeBacklinks);
    } catch (err) {
      logger.error('get_wiki_section failed', { key, error: err.message });
      return service.formatResponse({ error: err.message });
    }
  },
);

server.registerTool(
  'get_wiki_sections',
  {
    description:
      'Retrieve multiple wiki sections at once. Each section is truncated to save tokens.',
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
              updatedAt: z.string().nullable().optional().describe('ISO 8601 timestamp of the last update, or null if unknown'),
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
      requestCounts.get_wiki_sections++;
      logger.info('get_wiki_sections', { keys, wikiId });
      return await service.getWikiSections(keys, resolveWikiId(wikiId));
    } catch (err) {
      logger.error('get_wiki_sections failed', { keys, error: err.message });
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
  'get_wiki_info',
  {
    description:
      'Get metadata about the connected wiki instance — wiki IDs, section counts, and server uptime.',
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
      requestCounts.get_wiki_info++;
      const result = await service.getWikiInfo(resolveWikiId(wikiId));
      // Add uptime to the response
      result.structuredContent.uptime = (Date.now() - startedAt) / 1000;
      result.content[0].text = JSON.stringify(result.structuredContent, null, 2);
      logger.info('get_wiki_info', { wikiId });
      return result;
    } catch (err) {
      logger.error('get_wiki_info failed', { error: err.message });
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
      count: z.number().describe('Number of backlinks'),
      error: z.string().optional().describe('Error message if request failed'),
    },
    annotations: readOnlyAnnotations,
  },
  async ({ key, wikiId }) => {
    try {
      requestCounts.get_backlinks++;
      logger.info('get_backlinks', { key, wikiId });
      return await service.getBacklinks(key, resolveWikiId(wikiId));
    } catch (err) {
      logger.error('get_backlinks failed', { key, error: err.message });
      return service.formatResponse({ backlinks: [], count: 0, error: err.message });
    }
  },
);

server.registerTool(
  'validate_wiki',
  {
    description:
      'Run validation checks on wiki sections — finds empty sections, orphaned sections, and unlinked sections.',
    inputSchema: {
      ...wikiIdField(),
    },
    outputSchema: {
      emptySections: z
        .array(
          z.object({
            key: z.string(),
            title: z.string(),
          }),
        )
        .describe('Sections with no content'),
      orphanedSections: z
        .array(
          z.object({
            key: z.string(),
            title: z.string(),
          }),
        )
        .describe('Sections with no parent, children, or backlinks'),
      unlinkedSections: z
        .array(
          z.object({
            key: z.string(),
            title: z.string(),
          }),
        )
        .describe('Sections not linked from any other section'),
      emptySectionsCount: z.number().describe('Number of empty sections'),
      orphanedSectionsCount: z.number().describe('Number of orphaned sections'),
      unlinkedSectionsCount: z.number().describe('Number of unlinked sections'),
      error: z.string().optional().describe('Error message if request failed'),
    },
    annotations: readOnlyAnnotations,
  },
  async ({ wikiId }) => {
    try {
      requestCounts.validate_wiki++;
      logger.info('validate_wiki', { wikiId });
      return await service.validateWiki(resolveWikiId(wikiId));
    } catch (err) {
      logger.error('validate_wiki failed', { error: err.message });
      return service.formatResponse({
        emptySections: [],
        orphanedSections: [],
        unlinkedSections: [],
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
  'create_wiki',
  {
    description:
      'Create a new root-level wiki section with no parent. Use this to initialize a new wiki instance or create a top-level entry point for a wiki. For nested content under an existing topic, use create_section instead.',
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
      requestCounts.create_wiki++;
      logger.info('create_wiki', { wikiId, key, title });
      return await service.createSection(resolveWikiId(wikiId), key, title, content, null, tags, relatedKeys);
    } catch (err) {
      logger.error('create_wiki failed', { key, error: err.message });
      return service.formatResponse({ created: false, error: err.message });
    }
  },
);

server.registerTool(
  'create_section',
  {
    description:
      'Create a new bite-sized wiki section. CRITICAL: Before creating, ALWAYS search for existing sections using search_wiki to avoid duplicates. Check if a similar section already exists — if so, use update_section instead. Only create new sections for genuinely new topics.',
    inputSchema: {
      ...wikiIdField(),
      key: z.string().describe('Unique slug key (lowercase alphanumeric with hyphens)'),
      title: z.string().describe('Display title'),
      content: z
        .string()
        .describe(
          'Markdown content. KEEP IT SHORT AND BITE-SIZED. Maximum 3-4 bullet points or sentences per section. Do not combine multiple broad categories here.',
        ),
      parent: z.string().describe('Parent topic name'),
      tags: z.array(z.string()).optional().describe('Tags for categorization'),
      relatedKeys: z
        .array(z.string())
        .optional()
        .describe('Section keys to link to (populates section_links)'),
    },
    outputSchema: {
      key: z.string().optional().describe('Created section key'),
      wikiId: z.string().optional().describe('Wiki instance ID'),
      title: z.string().optional().describe('Section title'),
      parent: z.string().optional().describe('Parent topic name'),
      created: z.boolean().describe('Whether the section was created'),
      error: z.string().optional().describe('Error message if creation failed'),
    },
  },
  async ({ wikiId, key, title, content, parent, tags, relatedKeys }) => {
    try {
      requestCounts.create_section++;
      logger.info('create_section', { wikiId, key, title });
      return await service.createSection(resolveWikiId(wikiId), key, title, content, parent, tags, relatedKeys);
    } catch (err) {
      logger.error('create_section failed', { key, error: err.message });
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
            content: z.string().describe('Markdown content. Keep bite-sized: 3–4 bullets or sentences max.'),
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
      return service.formatResponse({ created: [], errors: [], successCount: 0, errorCount: sections.length });
    }
  },
);

server.registerTool(
  'update_section',
  {
    description:
      'Update an existing wiki section. Only provide fields you want to change. At least one of content, title, parent, tags, or relatedKeys must be provided.',
    inputSchema: {
      ...wikiIdField(),
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
    },
    outputSchema: {
      key: z.string().optional().describe('Updated section key'),
      wikiId: z.string().optional().describe('Wiki instance ID'),
      title: z.string().optional().describe('Updated section title'),
      updated: z.boolean().describe('Whether the section was updated'),
      error: z.string().optional().describe('Error message if update failed'),
    },
  },
  async ({ wikiId, key, content, title, parent, tags, reason, relatedKeys }) => {
    try {
      const resolvedWikiId = resolveWikiId(wikiId);
      requestCounts.update_section++;
      logger.info('update_section', { wikiId: resolvedWikiId, key, reason });
      return await service.updateSection(
        resolvedWikiId,
        key,
        content,
        title,
        parent,
        tags,
        reason,
        relatedKeys,
      );
    } catch (err) {
      logger.error('update_section failed', { key, error: err.message });
      return service.formatResponse({ updated: false, error: err.message });
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
      'Automatically find related sections using vector embeddings and link sections that lack them. Uses cosine similarity on stored embeddings. Always runs in the background — returns a status message immediately. Only one run per wiki is allowed at a time; calling again while in progress returns an error.',
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
      message: z.string().describe('Status message'),
      error: z.string().optional().describe('Error message if request failed'),
    }),
  },
  ({ wikiId, minSimilarity, maxLinks, override, reembed, parallel }) => {
    try {
      const resolvedWikiId = resolveWikiId(wikiId);
      requestCounts.auto_link_sections = (requestCounts.auto_link_sections || 0) + 1;
      logger.info('auto_link_sections', { wikiId: resolvedWikiId, minSimilarity, maxLinks, override, reembed, parallel });

      // If already running for this wiki, reject
      const taskKey = resolvedWikiId || 'default';
      if (backgroundTasks.has(taskKey)) {
        return service.formatResponse({
          message: '',
          error: `Auto-linking already in progress for ${taskKey}. Wait for it to complete.`,
        });
      }

      // Run in background and track for shutdown
      const task = service.autoLinkSections(resolvedWikiId, { minSimilarity, maxLinks, override, reembed, parallel });
      backgroundTasks.set(taskKey, task);
      task
        .then(() => {
          logger.info('auto_link_sections completed', { wikiId: resolvedWikiId });
        })
        .catch((err) => {
          logger.error('auto_link_sections failed (background)', { wikiId: resolvedWikiId, error: err.message });
        })
        .finally(() => {
          backgroundTasks.delete(taskKey);
        });

      return service.formatResponse({
        message: 'Auto-linking is running in the background. Results will not be sent back.',
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

// ─── IMPORT TOOL ─────────────────────────────────────────────────────────────

server.registerTool(
  'import_wiki',
  {
    description:
      'Import markdown files from import/staging into the wiki database. Files must have YAML frontmatter with key, parent, and title. Successful imports move to import/success, failures to import/fail. Auto-linking runs automatically after import.',
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
      requestCounts.import_wiki = (requestCounts.import_wiki || 0) + 1;
      logger.info('import_wiki');
      return await service.importWiki();
    } catch (err) {
      logger.error('import_wiki failed', { error: err.message });
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
  'export_wiki',
  {
    description:
      'Export wiki sections to markdown files. Exports all wikis by default, or a specific wiki if wikiId is provided.',
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
      requestCounts.export_wiki = (requestCounts.export_wiki || 0) + 1;
      logger.info('export_wiki', { outputDir, wikiId });
      return await service.exportWiki(outputDir, resolveWikiId(wikiId));
    } catch (err) {
      logger.error('export_wiki failed', { outputDir, error: err.message });
      return service.formatResponse({ results: [], error: err.message });
    }
  },
);

// ─── SHUTDOWN ────────────────────────────────────────────────────────────────

import * as db from './db.js';

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

  // Wait for all background tasks if running
  if (backgroundTasks.size > 0) {
    logger.info(`Waiting for ${backgroundTasks.size} background task(s)...`);
    await Promise.all(backgroundTasks.values());
  }

  await db.pool.end();
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

logger.info('Starting Wiki Explorer V2 MCP Server', {
  dbHost: process.env.DB_HOST || 'localhost',
  dbPort: process.env.DB_PORT || '5433',
  pid: process.pid,
  node: process.version,
});

await runMigrations();

const transport = new StdioServerTransport();
await server.connect(transport);
