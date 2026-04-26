# Wiki Explorer V2

MCP server for wiki management backed by PostgreSQL. Supports semantic search, vector embeddings, write operations, auto-backlinks, access tracking, and version history.

## Architecture

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  MCP Client │────▶│  wiki-v2 Server  │────▶│  PostgreSQL 16  │
│ (Claude Code)│◀────│  (Node.js)       │◀────│  + pgvector     │
└─────────────┘     └──────────────────┘     └─────────────────┘
                           │
                    ┌──────┴──────┐
                    │  wiki-cron  │  Daily auto-relink at 3am
                    └─────────────┘
```

### Code Architecture

- **`src/index.js`** — MCP server controller (tool registration, request routing)
- **`src/transport.js`** — Transport layer (stdio for local, HTTP for remote hosting)
- **`src/service.js`** — Business logic (validation, data transformation, orchestration)
- **`src/db.js`** — Database queries and connection pooling
- **`src/migrate.js`** — Forward-only migration runner (auto-runs on startup)
- **`src/embedding.js`** — Lazy-loaded `@xenova/transformers` embedding model
- **`src/import.js`** / **`src/export.js`** — Markdown import/export logic

## Quick Start

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) (includes Docker Compose)
- **Windows users:** run everything from WSL2 — Docker Desktop on Windows requires it anyway

### 1. Run the start script

```bash
./start.sh
```

This handles everything on first run and on restarts:

- Detects your Docker Compose version (`docker compose` vs `docker-compose`)
- Brings containers down then back up
- Installs `node_modules` inside the container if missing (no local Node.js required)
- Prints container health, wiki instance counts, and your MCP config path

The three containers started:
- **wiki-db** — PostgreSQL 16 with pgvector (port 5433)
- **wiki-server** — Node.js MCP server (volume-mounted for live editing)
- **wiki-cron** — Daily auto-relink job at 3am

Migrations in `sql/` are auto-applied on first start. After the initial setup, containers restart automatically on machine reboot — you only need `start.sh` again after a manual `docker compose down` or to pull updates.

### 2. Add the MCP config to Claude Code

Open `~/.claude.json` (printed by `start.sh`) and add under `mcpServers`:

```json
{
  "mcpServers": {
    "wiki": {
      "command": "docker",
      "args": ["exec", "-i", "wiki-v2-server", "node", "src/index.js"]
    }
  }
}
```

Restart Claude Code after saving. The wiki tools will appear automatically.

### 3. Import existing markdown files (optional)

Place markdown files with YAML frontmatter into `import/staging/`, then use the `import` tool from Claude Code, or run:

```bash
docker exec wiki-v2-server node scripts/import-wiki-to-db.js
```

## Agent Setup (Claude Code)

Add to `~/.claude.json` under `mcpServers`. The server runs inside the Docker container — connect via `docker exec` (or SSH if the host is remote).

### Local (docker exec)

```json
{
  "mcpServers": {
    "wiki": {
      "command": "docker",
      "args": ["exec", "-i", "wiki-v2-server", "node", "src/index.js"]
    }
  }
}
```

### Remote (SSH + docker exec)

```json
{
  "mcpServers": {
    "wiki": {
      "command": "ssh",
      "args": [
        "-T", "-o", "StrictHostKeyChecking=no",
        "user@host",
        "docker exec -i wiki-v2-server node src/index.js"
      ]
    }
  }
}
```

### Dual-server pattern (pinning a wiki instance)

Register the same server twice under different names — one without `WIKI_ID` (agent must pass it) and one with `WIKI_ID` forced via env (agent never passes it). This lets you dedicate a named tool set to a specific wiki instance:

```json
{
  "mcpServers": {
    "wiki": {
      "command": "ssh",
      "args": [
        "-T", "-o", "StrictHostKeyChecking=no",
        "user@host",
        "docker exec -i wiki-v2-server node src/index.js"
      ]
    },
    "memory": {
      "command": "ssh",
      "args": [
        "-T", "-o", "StrictHostKeyChecking=no",
        "user@host",
        "docker exec -i -e WIKI_ID=memory wiki-v2-server node src/index.js"
      ]
    }
  }
}
```

- `wiki` — general-purpose; agent selects the wiki instance per call
- `memory` — always targets the `memory` wiki; `wikiId` is absent from all tool schemas so the agent never needs to pass it

This pattern scales to any number of pinned instances (`notes`, `docs`, etc.) by adding more entries pointing to the same container with different `WIKI_ID` values.

### Remote Hosting (HTTP transport)

Set `TRANSPORT=http` to expose the server over HTTP instead of stdio. In HTTP mode, every client authenticates with an API key generated from the admin TUI (`npm run admin`). Each key maps to its own isolated PostgreSQL database — clients cannot access each other's data.

```bash
# Start locally with HTTP transport
TRANSPORT=http PORT=3000 DB_HOST=localhost DB_PORT=5433 node src/index.js
```

Or in Docker:

```yaml
# docker-compose override example
services:
  wiki-server-http:
    build: .
    container_name: wiki-v2-server-http
    environment:
      DB_HOST: wiki-db
      TRANSPORT: http
      PORT: 3000
    ports:
      - '3000:3000'
    command: node src/index.js
    depends_on:
      wiki-db:
        condition: service_healthy
```

#### Client MCP config (Claude Code)

Clients add the server to their `~/.claude.json` using the API key issued by the admin:

```json
{
  "mcpServers": {
    "wiki": {
      "transport": "http",
      "url": "https://your-host.example.com",
      "headers": {
        "Authorization": "Bearer wk_v2_..."
      }
    }
  }
}
```

Replace `wk_v2_...` with the plain key shown once at creation time in the admin TUI. The key determines which database the client's wiki data is stored in — no `wikiId` parameter is needed, the server resolves it automatically from the key.

The health check endpoint (`GET /health`) is always open with no auth required. All other endpoints require a valid bearer token.

#### Rate limiting

HTTP mode applies per-IP rate limiting: 10 failed auth attempts per minute before returning `429 Too Many Requests`. When running behind a reverse proxy, set `TRUST_PROXY=true` so the real client IP is read from `X-Forwarded-For` instead of the proxy's socket address.

## MCP Tools

### Discovery

| Tool        | Description                                                    |
| ----------- | -------------------------------------------------------------- |
| `get_info`  | Get instance metadata and section counts                       |
| `browse`    | Browse sections grouped by parent topic; supports `limit` and `offset` for pagination |
| `list`      | List all sections, optionally filtered by `wikiId`; supports `limit` and `offset`; includes tags and linkCount |

### Reading

| Tool            | Description                                                                  |
| --------------- | ---------------------------------------------------------------------------- |
| `search`        | Semantic search by meaning (falls back to keyword if embeddings unavailable); supports `parent` filter and `offset` pagination; results include content snippets |
| `get_section`   | Get a single section with content pagination; `includeBacklinks` optional; returns `backlinksHasMore` when backlinks are paginated |
| `get_sections`  | Batch retrieve multiple sections (max 20 at once)                            |

### Writing

| Tool              | Description                                                                   |
| ----------------- | ----------------------------------------------------------------------------- |
| `create`          | Create a root-level section with no parent (entry point for a new instance)   |
| `create_sections` | Batch-create multiple sections in parallel; all sections link to each other after creation (max 20) |
| `update_sections` | Batch-update existing sections (embedding auto-regenerated, history auto-tracked) |
| `delete_section`  | Delete a section and its backlinks (run `get_backlinks` first)                |

### Import/Export

| Tool     | Description                                                              |
| -------- | ------------------------------------------------------------------------ |
| `import` | Import markdown files from `import/staging/` (embeddings auto-generated) |
| `export` | Export sections to markdown files                                        |

### Management

| Tool                   | Description                                                                   |
| ---------------------- | ----------------------------------------------------------------------------- |
| `get_backlinks`        | Find sections that link to a given section; accepts `limit`, returns `hasMore` |
| `validate`             | Find empty, orphaned, and unlinked sections; returns counts and a `healthy` boolean |
| `get_section_history`  | View edit history for a section (`wikiId` optional)                           |
| `auto_link_sections`   | Auto-link sections via embedding similarity (background job; returns `jobId`) |
| `get_job_status`       | Poll the status of a background job by `jobId`                                |

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
| `./start.sh`                    | Start all containers, install deps if needed, print status and MCP config |
| `npm start`                     | Start the MCP server (outside Docker)          |
| `npm run dev`                   | Start with MCP inspector for debugging         |
| `npm run import`                | Import markdown from `import/staging/`         |
| `npm run export`                | Export all wikis to `export/` directory        |
| `npm run db:up`                 | Start database via docker-compose              |
| `npm run db:down`               | Stop database via docker-compose               |
| `npm run lint` / `lint:fix`     | Run ESLint                                     |
| `npm run format` / `format:check` | Run Prettier                                 |
| `npm run check`                 | Run lint + format check                        |
| `npm run fix`                   | Run lint:fix + format                          |
| `npm run admin`                 | Open the admin TUI dashboard (blessed)        |
| `npm test`                      | Run full test suite (unit + integration)       |
| `npm run test:unit`             | Run unit tests only                            |
| `npm run test:integration`      | Run integration tests only (requires DB)       |

### Import Directory Structure

```
import/
├── staging/    ← Place markdown files here for import
├── success/    ← Successfully imported files are moved here
└── fail/       ← Failed imports are moved here with error info
```

Files in `staging/` must have YAML frontmatter with `key`, `parent`, and `title`. The `wiki_id` field in the first section's frontmatter overrides the filename-derived wiki ID — useful when the filename doesn't match the intended wiki instance.

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
- **`004_trigger_fk.sql`** — Disables `extract_backlinks()` DB trigger (app layer manages all links); adds `section_history` FK with `ON DELETE CASCADE`

The migration runner creates a `migrations` table to track applied files. On first run, it marks existing SQL files as already applied (compatible with `docker-entrypoint-initdb.d`).

## Environment Variables

| Variable                  | Default     | Description                               |
| ------------------------- | ----------- | ----------------------------------------- |
| `DB_HOST`                 | `localhost` | PostgreSQL host                           |
| `DB_PORT`                 | `5433`      | PostgreSQL port                           |
| `DB_USER`                 | `wiki`      | Database user                             |
| `DB_PASSWORD`             | `wiki`      | Database password                         |
| `DB_NAME`                 | `wiki`      | Database name                             |
| `TRANSPORT`               | `stdio`     | Transport mode: `stdio` (local) or `http` (remote) |
| `PORT`                    | `3000`      | HTTP port (only used when `TRANSPORT=http`) |
| `WIKI_ID`                 | *(unset)*   | Default wiki ID for stdio mode. When set, `wikiId` is omitted from all tool schemas and resolved automatically. In HTTP mode this is ignored — wiki ID comes from the API key. |
| `TRUST_PROXY`             | *(unset)*   | Set to `true` to read the real client IP from `X-Forwarded-For` (enable when behind a reverse proxy for correct rate limiting) |
| `AUTH_CACHE_TTL_MS`       | `300000`    | How long (ms) a successful auth is cached before re-verification (default 5 min) |
| `AUTH_FAILED_CACHE_TTL_MS`| `60000`     | How long (ms) a failed token attempt is cached to skip bcrypt re-evaluation (default 1 min) |
| `MAX_LINKS_PER_SECTION`   | `4`         | Max outgoing links per section for auto-linking |
| `SIMILARITY_THRESHOLD`    | `0.1`       | Minimum cosine similarity score to use semantic search results (falls back to keyword below this) |
| `RELINK_DEBOUNCE_MS`      | `300000`    | Minimum interval (ms) between auto-relink triggers for the same section on read (default 5 min) |
| `AUTO_LINK_CONCURRENCY`   | `10`        | Max parallel DB connections used during `auto_link_sections` |
| `LOG_LEVEL`               | `info`      | Log level (debug, info, warn, error)      |
| `LOG_DIR`                 | `logs`      | Log directory                             |

## Migration from V1

V1 (`/home/dev/mcp/wiki/`) uses file-based parsing. V2 uses PostgreSQL. Both can coexist during transition.

1. V2 imports from the same markdown files V1 reads
2. V2 adds write capabilities that V1 doesn't have
3. V2 exports back to markdown for git tracking or external use
