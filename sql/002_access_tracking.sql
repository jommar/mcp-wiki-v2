-- Migration 002: Access tracking and auto-relinking support
-- Adds access_count and last_accessed columns to wiki_sections

ALTER TABLE wiki_sections ADD COLUMN IF NOT EXISTS access_count INT DEFAULT 0;
ALTER TABLE wiki_sections ADD COLUMN IF NOT EXISTS last_accessed TIMESTAMPTZ;
