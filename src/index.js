// src/index.js - MCP Server Controller
// Handles server setup, tool registration, and request routing

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { config } from 'dotenv';
import { logger } from '../logger.js';
import * as service from './service.js';

config();

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
  create_section: 0,
  update_section: 0,
  delete_section: 0,
  get_backlinks: 0,
  validate_wiki: 0,
  get_section_history: 0,
};

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
      wikiId: z
        .string()
        .optional()
        .describe('Filter by wiki instance (e.g., "user-wiki", "transact-wiki")'),
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
      return await service.listWiki(wikiId, limit);
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
      wikiId: z.string().optional().describe('Filter by wiki instance'),
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
      return await service.browseWiki(topic, wikiId, limit);
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
      wikiId: z.string().optional().describe('Filter by wiki instance'),
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
      suggestions: z.array(z.string()).optional().describe('Similar keys when no results found'),
      error: z.string().optional().describe('Error message if request failed'),
    },
    annotations: readOnlyAnnotations,
  },
  async ({ query, wikiId, fuzzy, limit }) => {
    try {
      requestCounts.search_wiki++;
      logger.info('search_wiki', { query, wikiId, fuzzy, limit });
      return await service.searchWiki(query, wikiId, fuzzy, limit);
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
      wikiId: z
        .string()
        .optional()
        .describe('Filter by wiki instance (required if key is not globally unique)'),
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
      relatedSections: z
        .array(
          z.object({
            key: z.string().describe('Related section key'),
            title: z.string().describe('Related section title'),
          }),
        )
        .optional()
        .describe('Related sections by key prefix'),
      error: z.string().optional().describe('Error message if section not found or key invalid'),
      suggestions: z.array(z.string()).optional().describe('Similar keys when section not found'),
    },
    annotations: readOnlyAnnotations,
  },
  async ({ key, wikiId, offset, limit }) => {
    try {
      requestCounts.get_wiki_section++;
      logger.info('get_wiki_section', { key, wikiId, offset, limit });
      return await service.getWikiSection(key, wikiId, offset, limit);
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
      wikiId: z.string().optional().describe('Filter by wiki instance'),
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
      return await service.getWikiSections(keys, wikiId);
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
      wikiId: z.string().optional().describe('Filter by wiki instance'),
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
      const result = await service.getWikiInfo(wikiId);
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
      wikiId: z.string().optional().describe('Filter by wiki instance'),
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
      return await service.getBacklinks(key, wikiId);
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
      wikiId: z.string().optional().describe('Filter by wiki instance'),
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
      error: z.string().optional().describe('Error message if request failed'),
    },
    annotations: readOnlyAnnotations,
  },
  async ({ wikiId }) => {
    try {
      requestCounts.validate_wiki++;
      logger.info('validate_wiki', { wikiId });
      return await service.validateWiki(wikiId);
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
      wikiId: z.string().describe('Wiki instance ID'),
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
  },
  async ({ key, wikiId, limit }) => {
    try {
      requestCounts.get_section_history++;
      logger.info('get_section_history', { key, wikiId, limit });
      return await service.getSectionHistory(wikiId, key, limit);
    } catch (err) {
      logger.error('get_section_history failed', { key, wikiId, error: err.message });
      return service.formatResponse({ history: [], count: 0, error: err.message });
    }
  },
);

// ─── WRITE TOOLS ─────────────────────────────────────────────────────────────

server.registerTool(
  'create_section',
  {
    description: 'Create a new wiki section.',
    inputSchema: {
      wikiId: z.string().describe('Wiki instance ID (e.g., "user-wiki", "transact-wiki")'),
      key: z.string().describe('Unique slug key (lowercase alphanumeric with hyphens)'),
      title: z.string().describe('Display title'),
      content: z.string().describe('Markdown content'),
      parent: z.string().optional().describe('Parent topic name'),
      tags: z.array(z.string()).optional().describe('Tags for categorization'),
    },
    outputSchema: {
      key: z.string().optional().describe('Created section key'),
      wikiId: z.string().optional().describe('Wiki instance ID'),
      title: z.string().optional().describe('Section title'),
      created: z.boolean().describe('Whether the section was created'),
      error: z.string().optional().describe('Error message if creation failed'),
    },
  },
  async ({ wikiId, key, title, content, parent, tags }) => {
    try {
      requestCounts.create_section++;
      logger.info('create_section', { wikiId, key, title });
      return await service.createSection(wikiId, key, title, content, parent, tags);
    } catch (err) {
      logger.error('create_section failed', { key, error: err.message });
      return service.formatResponse({ created: false, error: err.message });
    }
  },
);

server.registerTool(
  'update_section',
  {
    description: 'Update an existing wiki section. Only provide fields you want to change.',
    inputSchema: {
      wikiId: z.string().describe('Wiki instance ID'),
      key: z.string().describe('Section key to update'),
      content: z.string().optional().describe('New markdown content'),
      title: z.string().optional().describe('New display title'),
      parent: z.string().optional().describe('New parent topic'),
      tags: z.array(z.string()).optional().describe('New tags'),
      reason: z.string().optional().describe('Reason for the change (recorded in history)'),
    },
    outputSchema: {
      key: z.string().optional().describe('Updated section key'),
      wikiId: z.string().optional().describe('Wiki instance ID'),
      title: z.string().optional().describe('Updated section title'),
      updated: z.boolean().describe('Whether the section was updated'),
      error: z.string().optional().describe('Error message if update failed'),
    },
  },
  async ({ wikiId, key, content, title, parent, tags, reason }) => {
    try {
      requestCounts.update_section++;
      logger.info('update_section', { wikiId, key, reason });
      return await service.updateSection(wikiId, key, content, title, parent, tags, reason);
    } catch (err) {
      logger.error('update_section failed', { key, error: err.message });
      return service.formatResponse({ updated: false, error: err.message });
    }
  },
);

server.registerTool(
  'delete_section',
  {
    description: 'Delete a wiki section. This also removes all backlinks to/from this section.',
    inputSchema: {
      wikiId: z.string().describe('Wiki instance ID'),
      key: z.string().describe('Section key to delete'),
    },
    outputSchema: {
      key: z.string().optional().describe('Deleted section key'),
      wikiId: z.string().optional().describe('Wiki instance ID'),
      title: z.string().optional().describe('Deleted section title'),
      deleted: z.boolean().describe('Whether the section was deleted'),
      error: z.string().optional().describe('Error message if deletion failed'),
    },
  },
  async ({ wikiId, key }) => {
    try {
      requestCounts.delete_section++;
      logger.info('delete_section', { wikiId, key });
      return await service.deleteSection(wikiId, key);
    } catch (err) {
      logger.error('delete_section failed', { key, error: err.message });
      return service.formatResponse({ deleted: false, error: err.message });
    }
  },
);

// ─── IMPORT/EXPORT TOOLS ─────────────────────────────────────────────────────

server.registerTool(
  'import_wiki',
  {
    description:
      'Import markdown files or a directory of markdown into the wiki database. Supports single .md files or directories. Auto-detects wiki_id from path basename unless explicitly provided.',
    inputSchema: {
      sourcePath: z.string().describe('Path to a .md file or directory containing .md files'),
      wikiId: z
        .string()
        .optional()
        .describe('Wiki instance ID (auto-detected from path basename if not provided)'),
    },
    outputSchema: {
      wikiId: z.string().describe('Wiki instance ID that was imported into'),
      imported: z.number().describe('Number of sections imported'),
      errors: z.array(z.string()).describe('List of errors for sections that failed to import'),
      error: z.string().optional().describe('Error message if import failed entirely'),
    },
  },
  async ({ sourcePath, wikiId }) => {
    try {
      requestCounts.import_wiki = (requestCounts.import_wiki || 0) + 1;
      logger.info('import_wiki', { sourcePath, wikiId });
      return await service.importWiki(sourcePath, wikiId);
    } catch (err) {
      logger.error('import_wiki failed', { sourcePath, error: err.message });
      return service.formatResponse({
        wikiId: wikiId || '',
        imported: 0,
        errors: [],
        error: err.message,
      });
    }
  },
);

server.registerTool(
  'export_wiki',
  {
    description:
      'Export wiki sections to markdown files. Exports all wikis by default, or a specific wiki if wikiId is provided.',
    inputSchema: {
      outputDir: z.string().describe('Directory to write exported markdown files to'),
      wikiId: z
        .string()
        .optional()
        .describe('Export only this wiki (exports all wikis if not provided)'),
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
      return await service.exportWiki(outputDir, wikiId);
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

logger.info('Starting Wiki Explorer V2 MCP Server', {
  dbHost: process.env.DB_HOST || 'localhost',
  dbPort: process.env.DB_PORT || '5433',
  pid: process.pid,
  node: process.version,
});

const transport = new StdioServerTransport();
await server.connect(transport);
