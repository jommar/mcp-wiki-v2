# CLAUDE.md

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 0. The Wiki Protocol (Second Brain)

Prioritize the Wiki as the project's source of truth. Use internal knowledge for general best practices, but defer to the Wiki for project-specific architecture, conventions, and history.

### 0.1 Reading: Search → Browse → Read

1. **`search_wiki`** — default entry point. Natural language, not keywords.
2. **`browse_wiki`** — when you know the topic but not the key.
3. **`get_wiki_section`** — only with a confirmed key. Paginate with `offset`/`limit`; don't request huge limits.
4. **`get_wiki_sections`** — batch 2+ known keys in one call.
5. **`get_backlinks`** / `includeBacklinks: true` — before editing foundational sections.
6. **`list_wiki`** — last resort; prefer `browse_wiki`.

Never guess a key. If search returns nothing, say so — don't fabricate.

### 0.2 Writing: Search Before You Write

**#1 mistake is duplicates.** Before every `create_section`:

1. `search_wiki` in natural language.
2. Retry with alternate phrasings (e.g., "approval workflow" → "sign-off routing").
3. Related section exists → `update_section`.
4. Existing section too broad → create bite-sized + link via `relatedKeys`.

Only create for genuinely new, distinct topics.

### 0.3 Bite-Sized Sections (Non-Negotiable)

Sections are atomic units, not documents.

- Max 3–4 bullets/sentences. One concept per section.
- If you're writing "also" or "additionally" — split.
- Draft >500 chars — split.

Bad: one `approval-workflow` covering routing, notifications, escalations, audit.
Good: `approval-routing`, `approval-notifications`, `approval-escalations`, `approval-audit-trails` — linked via `relatedKeys`.

### 0.4 Key Naming

- Lowercase alphanumeric + hyphens: `portage-backend-architecture`.
- Prefix domain when ambiguous: `transact-approval-routing`.
- Stable over clever — keys are referenced; renaming is expensive.
- Match what a future reader would search, not internal jargon.

### 0.5 Linking Discipline

- Always set `relatedKeys` on create/update. Unlinked = orphan.
- 2–4 links per section. More is noise; fewer is isolation.
- On update, reconsider links — stale links are worse than none.
- `auto_link_sections` is a backstop, not a substitute for thoughtful linking.

### 0.6 Updates and History

- Always pass `reason` to `update_section`.
- Read `get_section_history` before large rewrites.
- Prefer small focused updates over wholesale rewrites.

### 0.7 wikiId

- Pass `wikiId` whenever known.
- Required for `get_wiki_section` when key isn't globally unique.
- Required for all writes (`create_section`, `update_section`, `delete_section`).

### 0.8 Deletion Is Last Resort

- `delete_section` cascades through backlinks.
- Prefer `update_section` with a deprecation note.
- If deleting, run `get_backlinks` first to see what breaks.

### 0.9 Validation

Run `validate_wiki` after batch creates/imports, on a new wiki, or periodically during long sessions. Act on output: fill or delete empties, link orphans, add `relatedKeys` to unlinked.

### 0.10 Token Economy

- Metadata tools (`search_wiki`, `browse_wiki`) before content tools (`get_wiki_section`).
- Batch with `get_wiki_sections`, don't loop.
- Respect default limits; paginate instead of requesting everything.
- Use `search_wiki` snippets before fetching full content.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:

- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:

- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:

```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
