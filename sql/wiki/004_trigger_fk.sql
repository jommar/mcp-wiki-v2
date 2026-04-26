-- Migration 004: Disable extract_backlinks() trigger, add section_history FK
--
-- A1: The extract_backlinks() DB trigger silently clobbers app-level links set
--     via relatedKeys and embedding similarity. The app layer (insertExplicitLinks,
--     relinkSection) is now the sole manager of section_links. The [[key]] syntax
--     in content is for human readability only — not a linking mechanism.
--     Decision: option (a) — disable the trigger, manage ALL links from app layer.
--
-- A2: section_history gets a FK with ON DELETE CASCADE so that deleting a section
--     also cleans up its history rows, preventing orphan accumulation.
--     Decision: option (a) — FK with ON DELETE CASCADE.

-- Drop the extract_backlinks() trigger and keep the function as documentation
DROP TRIGGER IF EXISTS wiki_sections_backlinks_trigger ON wiki_sections;

-- Add FK from section_history to wiki_sections with ON DELETE CASCADE
-- First drop if exists (safe for re-runs)
ALTER TABLE section_history
DROP CONSTRAINT IF EXISTS fk_section_history_section;

ALTER TABLE section_history
ADD CONSTRAINT fk_section_history_section
  FOREIGN KEY (wiki_id, section_key)
  REFERENCES wiki_sections (wiki_id, key)
  ON DELETE CASCADE;
