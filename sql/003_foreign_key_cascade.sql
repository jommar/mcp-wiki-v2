-- Migration 003: Foreign key cascade for section_links
-- We add 'DROP CONSTRAINT IF EXISTS' to prevent crashes if already applied

ALTER TABLE section_links
DROP CONSTRAINT IF EXISTS fk_section_links_from;

ALTER TABLE section_links
ADD CONSTRAINT fk_section_links_from FOREIGN KEY (from_wiki_id, from_key) REFERENCES wiki_sections (wiki_id, key) ON DELETE CASCADE;

ALTER TABLE section_links
DROP CONSTRAINT IF EXISTS fk_section_links_to;

ALTER TABLE section_links
ADD CONSTRAINT fk_section_links_to FOREIGN KEY (to_wiki_id, to_key) REFERENCES wiki_sections (wiki_id, key) ON DELETE CASCADE;