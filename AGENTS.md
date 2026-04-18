# AGENTS.md — Wiki V2 Agent Instructions

## Overview

This is a PostgreSQL-backed wiki system exposed via MCP tools. You can read, write, search, and manage wiki sections programmatically.

## Available Tools

### Discovery

1. **`get_wiki_info`** — Check what wiki instances exist and their section counts
2. **`browse_wiki`** — Explore sections by topic/parent
3. **`list_wiki`** — Get all section keys (use sparingly, can be large)

### Reading

4. **`search_wiki`** — Semantic search by meaning (falls back to keyword if embeddings unavailable)
5. **`get_wiki_section`** — Read a specific section by key
6. **`get_wiki_sections`** — Batch read multiple sections (max 20 at once)

### Writing

7. **`create_section`** — Create a new section (embedding auto-generated)
8. **`update_section`** — Update an existing section (embedding auto-regenerated, history auto-tracked)
9. **`delete_section`** — Delete a section

### Import/Export

10. **`import_wiki`** — Import markdown files or directories into the database (embeddings auto-generated)
11. **`export_wiki`** — Export wiki sections to markdown files

### Management

12. **`get_backlinks`** — Find what sections link to a given section
13. **`validate_wiki`** — Check for empty, orphaned, or unlinked sections
14. **`get_section_history`** — View edit history

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
3. If not exists: create_section(wiki_id="...", key="new-key", title="Title", content="...")
```

### Creating New Sections

- **key**: lowercase alphanumeric with hyphens (e.g., `portage-backend-architecture`)
- **wiki_id**: `user-wiki` or `transact-wiki`
- **content**: markdown format
- Use `[[existing-key]]` syntax in content to create backlinks

### Backlinks

Sections can reference each other using `[[wiki-key]]` syntax in their content. The database auto-extracts these and populates the `section_links` table.

```markdown
See also: [[wiki-approval-workflow-deep-dive]]
Related: [[portage-backend-database]]
```

## Conventions

### Key Naming

- Use descriptive, hyphenated slugs: `portage-backend-architecture`
- Prefix with context when needed: `wiki-docker-architecture`
- Keep keys globally unique across both wiki instances

### Content Structure

- Use standard markdown (headings, lists, code blocks, tables)
- First heading in content becomes the section title
- Use `[[key]]` for cross-references

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
- **Use `get_wiki_sections` for batch reads**: More efficient than multiple `get_wiki_section` calls
- **Check `validate_wiki` periodically**: Find and clean up empty/orphaned sections
- **Use `get_section_history` before updating**: See what changed previously
- **Use `get_backlinks` before deleting**: Ensure you're not breaking references
