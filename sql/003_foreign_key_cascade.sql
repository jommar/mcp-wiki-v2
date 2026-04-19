-- Migration 003: Foreign key cascade for section_links
-- Ensures deleting a wiki_section automatically removes related backlinks

ALTER TABLE section_links
  ADD CONSTRAINT fk_section_links_from
    FOREIGN KEY (from_wiki_id, from_key) REFERENCES wiki_sections(wiki_id, key)
    ON DELETE CASCADE;

ALTER TABLE section_links
  ADD CONSTRAINT fk_section_links_to
    FOREIGN KEY (to_wiki_id, to_key) REFERENCES wiki_sections(wiki_id, key)
    ON DELETE CASCADE;
