# Wiki Explorer V2

MCP server for wiki management backed by PostgreSQL. Supports semantic search, vector embeddings, write operations, auto-backlinks, access tracking, and version history.

## Architecture

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  MCP Client │────▶│  wiki-v2 Server  │────▶│  PostgreSQL 16  │
│  (OpenCode) │◀────│  (Node.js)       │◀────│  + pgvector     │
└─────────────┘     └──────────────────┘     └─────────────────┘
                           │
                    ┌──────┴──────┐
                    │  wiki-cron  │  Daily auto-relink at 3am
                    └─────────────┘
```

### Code Architecture

- **`src/index.js`** — MCP server controller (tool registration, request routing)
- **`src/service.js`** — Business logic (validation, data transformation, orchestration)
- **`src/db.js`** — Database queries and connection pooling
- **`src/migrate.js`** — Forward-only migration runner (auto-runs on startup)
- **`src/embedding.js`** — Lazy-loaded `@xenova/transformers` embedding model
- **`src/import.js`** / **`src/export.js`** — Markdown import/export logic

## Quick Start

### 1. Install dependencies

```bash
npm install
npm run init  # Set up pre-commit hook for lint + format
```

### 2. Start the database

```bash
docker-compose up -d
```

This starts 3 containers:
- **wiki-db** — PostgreSQL 16 with pgvector (port 5433)
- **wiki-server** — Node.js server (volume-mounted for live editing)
- **wiki-cron** — Daily auto-relink job at 3am

On first start, migrations in `sql/` are auto-applied by the migration runner.

### 3. Import existing markdown files

Place markdown files with YAML frontmatter into `import/staging/`, then:

```bash
# Via MCP tool (recommended)
# Use import_wiki tool from your MCP client

# Or via CLI script
node scripts/import-wiki-to-db.js
```

### 4. Start the MCP server

```bash
npm start
```

Or use MCP inspector for debugging:

```bash
npm run dev
```

Or configure your MCP client:

```json
{
  "wiki-v2": {
    "type": "local",
    "command": ["node", "/home/dev/mcp/wiki-v2/src/index.js"],
    "environment": {
      "DB_HOST": "127.0.0.1",
      "DB_PORT": "5433",
      "DB_USER": "wiki",
      "DB_PASSWORD": "wiki",
      "DB_NAME": "wiki",
      "LOG_LEVEL": "info",
      "LOG_DIR": "/home/dev/mcp/wiki-v2/logs"
    }
  }
}
```

## MCP Tools

### Discovery

| Tool              | Description                                                    |
| ----------------- | -------------------------------------------------------------- |
| `get_wiki_info`   | Get wiki instance metadata and section counts                  |
| `browse_wiki`     | Browse sections grouped by parent topic                        |
| `list_wiki`       | List all sections, optionally filtered by `wikiId` and `limit` |

### Reading

| Tool                | Description                                                                  |
| ------------------- | ---------------------------------------------------------------------------- |
| `search_wiki`       | Semantic search by meaning (falls back to keyword if embeddings unavailable); results include content snippets |
| `get_wiki_section`  | Get a single section with content pagination; `includeBacklinks` optional    |
| `get_wiki_sections` | Batch retrieve multiple sections (max 20 at once)                            |

### Writing

| Tool              | Description                                                                   |
| ----------------- | ----------------------------------------------------------------------------- |
| `create_wiki`     | Create a root-level section with no parent (entry point for a new wiki instance) |
| `create_section`  | Create a new wiki section under a parent topic (embedding auto-generated)     |
| `create_sections` | Batch-create multiple sections in parallel; all sections link to each other after creation (max 20) |
| `update_section`  | Update an existing section (embedding auto-regenerated, history auto-tracked) |
| `delete_section`  | Delete a section and its backlinks (run `get_backlinks` first)                |

### Import/Export

| Tool          | Description                                                      |
| ------------- | ---------------------------------------------------------------- |
| `import_wiki` | Import markdown files from `import/staging/` (embeddings auto-generated) |
| `export_wiki` | Export wiki sections to markdown files                           |

### Management

| Tool                   | Description                                                    |
| ---------------------- | -------------------------------------------------------------- |
| `get_backlinks`        | Find sections that link to a given section                     |
| `validate_wiki`        | Find empty, orphaned, and unlinked sections; returns counts alongside arrays |
| `get_section_history`  | View edit history for a section (`wikiId` optional)            |
| `auto_link_sections`   | Auto-link sections via embedding similarity (background job)   |

### `auto_link_sections` Options

| Option      | Description                                              |
| ----------- | -------------------------------------------------------- |
| `override`  | Re-link sections that already have links                 |
| `reembed`   | Regenerate embeddings before linking                     |
| `parallel`  | Process sections in parallel (default: true)             |
| `minSimilarity` | Minimum cosine similarity threshold (0-1, default 0.1) |
| `maxLinks`  | Maximum number of related links per section (default 4)  |

This tool runs in the background and returns an immediate status message. A cron job also runs it daily at 3am via the `wiki-cron` container.

## Scripts

| Script                          | Purpose                                        |
| ------------------------------- | ---------------------------------------------- |
| `npm start`                     | Start the MCP server                           |
| `npm run dev`                   | Start with MCP inspector for debugging         |
| `npm run import`                | Import markdown from `import/staging/`         |
| `npm run export`                | Export all wikis to `export/` directory        |
| `npm run db:up`                 | Start database via docker-compose              |
| `npm run db:down`               | Stop database via docker-compose               |
| `npm run lint` / `lint:fix`     | Run ESLint                                     |
| `npm run format` / `format:check` | Run Prettier                                 |
| `npm run check`                 | Run lint + format check                        |
| `npm run fix`                   | Run lint:fix + format                          |
| `npm run init`                  | Install pre-commit hook                        |
| `npm test`                      | Run test suite                                 |

### Import Directory Structure

```
import/
├── staging/    ← Place markdown files here for import
├── success/    ← Successfully imported files are moved here
└── fail/       ← Failed imports are moved here with error info
```

Files in `staging/` must have YAML frontmatter with `key`, `parent`, and `title`.

### Embeddings

Embeddings are generated automatically on every write operation (create, update, import). No manual seeding is needed.

Uses `@xenova/transformers` with `all-MiniLM-L6-v2` (384-dim, quantized) — runs locally with no API key required.

## Database Schema

| Table             | Purpose                                                                  |
| ----------------- | ------------------------------------------------------------------------ |
| `wiki_sections`   | Main content table with FTS, vector, and access tracking columns         |
| `section_links`   | Canonical source of truth for wiki relationships (auto-populated)        |
| `section_history` | Version history (auto-populated on updates)                              |
| `migrations`      | Tracks applied migration files                                           |

### `wiki_sections` Columns

| Column           | Type        | Description                                    |
| ---------------- | ----------- | ---------------------------------------------- |
| `key`            | VARCHAR     | Unique slug key (PK)                           |
| `wiki_id`        | VARCHAR     | Wiki instance ID                               |
| `title`          | VARCHAR     | Display title                                  |
| `parent`         | VARCHAR     | Parent topic/group                             |
| `content`        | TEXT        | Markdown content                               |
| `tags`           | TEXT[]      | Category tags                                  |
| `embedding`      | vector(384) | Semantic embedding (auto-generated)            |
| `search_vector`  | tsvector    | Full-text search index (auto-populated)        |
| `access_count`   | INT         | Read count (capped at 9999)                    |
| `last_accessed`  | TIMESTAMPTZ | Last read timestamp                            |
| `created_at`     | TIMESTAMPTZ | Creation timestamp                             |
| `updated_at`     | TIMESTAMPTZ | Last update timestamp                          |

### Key Features

- **Full-text search**: `tsvector` column with weighted ranking (title > content > tags)
- **Fuzzy search**: pg_trigram similarity for typo tolerance
- **Vector search**: 384-dim embeddings via pgvector (HNSW index)
- **Smart linking**: `relatedKeys` on create/update inserts explicit links (validated against existing sections); embedding-based auto-link fires as fallback when no explicit keys are given
- **Relink on content change**: updating `content` or `title` regenerates the embedding and auto-relinks immediately
- **Auto-backlinks**: `section_links` table is the canonical source of truth, populated via `relatedKeys` param and `auto_link_sections`
- **Auto-history**: Trigger logs content changes with timestamps
- **Auto-search-vector**: Trigger populates FTS index on insert/update
- **Access tracking**: `access_count` and `last_accessed` updated on every read
- **Read-triggered linking**: sections with no outgoing links are auto-linked on first read (safety net for orphans); sections that already have links are skipped

## Migrations

Migrations live in `sql/` and are auto-applied on server startup by `src/migrate.js`:

- **`001_initial_schema.sql`** — Core tables, triggers, extensions
- **`002_access_tracking.sql`** — Adds `access_count` and `last_accessed` columns
- **`003_foreign_key_cascade.sql`** — Adds cascade deletes for relationships

The migration runner creates a `migrations` table to track applied files. On first run, it marks existing SQL files as already applied (compatible with `docker-entrypoint-initdb.d`).

## Environment Variables

| Variable       | Default                 | Description                               |
| -------------- | ----------------------- | ----------------------------------------- |
| `DB_HOST`      | `localhost`             | PostgreSQL host                           |
| `DB_PORT`      | `5433`                  | PostgreSQL port                           |
| `DB_USER`      | `wiki`                  | Database user                             |
| `DB_PASSWORD`  | `wiki`                  | Database password                         |
| `DB_NAME`      | `wiki`                  | Database name                             |
| `LOG_LEVEL`    | `info`                  | Log level (debug, info, warn, error)      |
| `LOG_DIR`      | `logs`                  | Log directory                             |

## Migration from V1

V1 (`/home/dev/mcp/wiki/`) uses file-based parsing. V2 uses PostgreSQL. Both can coexist during transition.

1. V2 imports from the same markdown files V1 reads
2. V2 adds write capabilities that V1 doesn't have
3. V2 exports back to markdown for git tracking or external use
