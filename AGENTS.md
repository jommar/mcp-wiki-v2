# AGENTS.md — Wiki V2 Agent Instructions

## Overview

This is a PostgreSQL-backed wiki system exposed via MCP tools. You can read, write, search, and manage wiki sections programmatically.

## Available Tools

### Discovery

1. **`get_wiki_info`** — Check what wiki instances exist and their section counts
2. **`browse_wiki`** — Explore sections by topic/parent
3. **`list_wiki`** — Get all section keys (use sparingly, can be large; supports `limit` param)

### Reading

4. **`search_wiki`** — Semantic search by meaning (falls back to keyword if embeddings unavailable); results include a `snippet` (first 200 chars of content) — use this to triage relevance before fetching full sections
5. **`get_wiki_section`** — Read a specific section by key; supports `includeBacklinks` for optional backlink retrieval
6. **`get_wiki_sections`** — Batch read multiple sections (max 20 at once)

### Writing

7. **`create_section`** — Create a new section (embedding auto-generated, `parent` is **required**)
8. **`update_section`** — Update an existing section (embedding auto-regenerated, history auto-tracked)
9. **`delete_section`** — Delete a section and all its backlinks; run `get_backlinks` first to see what would break

### Import/Export

10. **`import_wiki`** — Import markdown files from `import/staging/` into the database (embeddings auto-generated)
11. **`export_wiki`** — Export wiki sections to markdown files

### Management

12. **`get_backlinks`** — Find what sections link to a given section
13. **`validate_wiki`** — Check for empty, orphaned, or unlinked sections; returns counts (`emptySectionsCount`, `orphanedSectionsCount`, `unlinkedSectionsCount`) alongside the full arrays
14. **`get_section_history`** — View edit history (`wikiId` absent when `WIKI_ID` env is set; required otherwise)
15. **`auto_link_sections`** — Auto-link sections via embedding similarity (runs in background, returns status message)

## Workflow

### Finding Information

```
1. search_wiki(query="your topic") → get matching keys
2. get_wiki_section(key="matched-key") → read content
3. If not found, try browse_wiki(topic="related topic")
```

### Updating Documentation

After completing a task (feature, bug fix, migration):

```
1. search_wiki(query="relevant topic") → find existing section
2. If exists: update_section(key="...", content="new content", reason="what changed")
3. If not exists: create_section(key="new-key", title="Title", content="...", parent="...")
```

### Creating New Sections

- **key**: lowercase alphanumeric with hyphens (e.g., `portage-backend-architecture`)
- **wikiId**: omit if `WIKI_ID` env is set (resolved automatically); required otherwise (e.g., `user-wiki`)
- **parent**: **required** — the parent topic/group name
- **content**: markdown format
- **relatedKeys**: optional array of section keys to link to (auto-discovers via embedding similarity)

> **CRITICAL**: Before creating, ALWAYS search for existing sections using `search_wiki` to avoid duplicates. Check if a similar section already exists — if so, use `update_section` instead. Only create new sections for genuinely new topics.

### Backlinks & Section Links

The `section_links` table is the **canonical source of truth** for wiki relationships. Links are managed via:

1. **`relatedKeys` param** on `create_section` / `update_section` — explicitly link to other sections
2. **`auto_link_sections`** — embedding-based automatic linking (runs in background)

Links are auto-discovered via embedding similarity — you do **not** need to manually write `[[key]]` in content. The `[[key]]` syntax is still supported for human readability but is not the primary linking mechanism.

Export appends `**Related:**` blocks from `section_links` (not from content). Import parses `**Related:**` from markdown into `section_links`.

```markdown
Related: [[portage-backend-database]]
```

### Auto-Linking Options

| Option      | Description                                              |
| ----------- | -------------------------------------------------------- |
| `override`  | Re-link sections that already have links                 |
| `reembed`   | Regenerate embeddings before linking                     |
| `parallel`  | Process sections in parallel (default: true)             |
| `minSimilarity` | Minimum cosine similarity threshold (0-1, default 0.1) |
| `maxLinks`  | Maximum number of related links per section (default 4)  |

A cron job also runs auto-relink daily at 3am via the `wiki-cron` container.

## Conventions

### Key Naming

- Use descriptive, hyphenated slugs: `portage-backend-architecture`
- Prefix with context when needed: `wiki-docker-architecture`
- Keep keys globally unique across both wiki instances

### Content Structure

- Use standard markdown (headings, lists, code blocks, tables)
- First heading in content becomes the section title
- Keep content bite-sized (3-4 bullet points or sentences per section)

### When to Update the Wiki

Update wiki sections when:

1. User confirms a feature/fix is complete
2. A new architectural constraint is established
3. Tech stack or tooling changes
4. You discover outdated or incorrect documentation

### When NOT to Update

- Don't create speculative documentation for features that don't exist
- Don't update sections you haven't verified are relevant
- Don't delete sections without confirming they're truly obsolete

## Tips

- **Search first, browse second**: `search_wiki` is faster than scanning `list_wiki`
- **Use snippets to triage**: `search_wiki` results include a 200-char `snippet` — read it before calling `get_wiki_section` to avoid fetching irrelevant sections
- **Use `get_wiki_sections` for batch reads**: More efficient than multiple `get_wiki_section` calls
- **Check `validate_wiki` periodically**: Find and clean up empty/orphaned sections
- **Use `get_section_history` before updating**: See what changed previously
- **Use `get_backlinks` before deleting**: Ensure you're not breaking references
- **Use `includeBacklinks: true`** on `get_wiki_section` when you need to see what links to a section
- **Access is tracked**: Every read increments `access_count` and updates `last_accessed`
- **Background relinking**: Sections are auto-relinked on read via embedding similarity — no manual intervention needed
