# Wiki Explorer V2

MCP server for wiki management backed by PostgreSQL. Replaces the file-based wiki parser with a database-backed system supporting full-text search, vector embeddings, write operations, backlinks, and version history.

## Architecture

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  MCP Client │────▶│  wiki-v2 Server  │────▶│  PostgreSQL 16  │
│  (OpenCode) │◀────│  (Node.js)       │◀────│  + pgvector     │
└─────────────┘     └──────────────────┘     └─────────────────┘
```

## Quick Start

### 1. Start the database

```bash
docker-compose up -d
```

### 2. Import existing markdown files

```bash
WIKI_SOURCES=/ai/wiki,/home/dev/transAct/docs node scripts/import-wiki-to-db.js
```

### 3. Start the MCP server

```bash
node src/index.js
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

### Read Tools

| Tool                | Description                                                                  |
| ------------------- | ---------------------------------------------------------------------------- |
| `list_wiki`         | List all sections, optionally filtered by `wikiId`                           |
| `browse_wiki`       | Browse sections grouped by parent topic                                      |
| `search_wiki`       | Semantic search by meaning (falls back to keyword if embeddings unavailable) |
| `get_wiki_section`  | Get a single section with content pagination                                 |
| `get_wiki_sections` | Batch retrieve multiple sections                                             |
| `get_wiki_info`     | Get wiki instance metadata and section counts                                |

### Write Tools

| Tool             | Description                                                                   |
| ---------------- | ----------------------------------------------------------------------------- |
| `create_section` | Create a new wiki section (embedding auto-generated)                          |
| `update_section` | Update an existing section (embedding auto-regenerated, history auto-tracked) |
| `delete_section` | Delete a section and its backlinks                                            |

### Import/Export Tools

| Tool          | Description                                                      |
| ------------- | ---------------------------------------------------------------- |
| `import_wiki` | Import markdown files or directories (embeddings auto-generated) |
| `export_wiki` | Export wiki sections to markdown files                           |

### Management Tools

| Tool                  | Description                                 |
| --------------------- | ------------------------------------------- |
| `get_backlinks`       | Find sections that link to a given section  |
| `validate_wiki`       | Find empty, orphaned, and unlinked sections |
| `get_section_history` | View edit history for a section             |

## Scripts

| Script                           | Purpose                                        |
| -------------------------------- | ---------------------------------------------- |
| `scripts/import-wiki-to-db.js`   | Import markdown files → PostgreSQL             |
| `scripts/export-wiki-to-md.js`   | Export PostgreSQL → markdown files             |
| `scripts/generate-embeddings.js` | Generate vector embeddings for semantic search |

### Import

```bash
# Import from source directories
WIKI_SOURCES=/ai/wiki,/home/dev/transAct/docs node scripts/import-wiki-to-db.js

# Import from staging directory (mounted as /import in Docker)
WIKI_SOURCES=/import/user-wiki,/import/transact-wiki node scripts/import-wiki-to-db.js
```

### Export

```bash
# Export all wikis
node scripts/export-wiki-to-md.js

# Export single wiki
node scripts/export-wiki-to-md.js --wiki user-wiki

# Custom output directory
node scripts/export-wiki-to-md.js --output /tmp/wiki-export
```

### Embeddings

Embeddings are generated automatically on every write operation (create, update, import).
The batch script is only needed for seeding existing sections that lack embeddings:

```bash
node scripts/generate-embeddings.js
```

Uses `@xenova/transformers` with `all-MiniLM-L6-v2` (384-dim, quantized) — runs locally with no API key required.

## Database Schema

| Table             | Purpose                                                                  |
| ----------------- | ------------------------------------------------------------------------ |
| `wiki_sections`   | Main content table with FTS and vector columns                           |
| `section_links`   | Backlinks between sections (auto-populated from `[[wiki-key]]` patterns) |
| `section_history` | Version history (auto-populated on updates)                              |

### Key Features

- **Full-text search**: `tsvector` column with weighted ranking (title > content > tags)
- **Fuzzy search**: pg_trigram similarity for typo tolerance
- **Vector search**: 384-dim embeddings via pgvector (HNSW index)
- **Auto-backlinks**: Trigger extracts `[[wiki-key]]` patterns on insert/update
- **Auto-history**: Trigger logs content changes with timestamps
- **Auto-search-vector**: Trigger populates FTS index on insert/update

## Migration from V1

V1 (`/home/dev/mcp/wiki/`) uses file-based parsing. V2 uses PostgreSQL. Both can coexist during transition.

1. V2 imports from the same markdown files V1 reads
2. V2 adds write capabilities that V1 doesn't have
3. V2 exports back to markdown for git tracking or external use

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
| `WIKI_SOURCES` | _(required for import)_ | Comma-separated paths to markdown sources |
