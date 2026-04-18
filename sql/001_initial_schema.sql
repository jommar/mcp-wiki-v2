-- Wiki V2 Database Schema
-- Loaded automatically by PostgreSQL docker entrypoint

-- Enable extensions
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Main sections table
CREATE TABLE wiki_sections (
    id SERIAL PRIMARY KEY,
    wiki_id VARCHAR(50) NOT NULL,
    key VARCHAR(255) NOT NULL,
    parent VARCHAR(255),
    title VARCHAR(500) NOT NULL,
    content TEXT NOT NULL,
    tags VARCHAR(100)[],
    status VARCHAR(20) DEFAULT 'active',
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(wiki_id, key)
);

-- Full-text search column (populated by trigger, not generated)
ALTER TABLE wiki_sections ADD COLUMN search_vector tsvector;

CREATE INDEX wiki_sections_search_idx ON wiki_sections USING GIN(search_vector);

-- Trigram index for fuzzy/partial matching on titles
CREATE INDEX wiki_sections_title_trgm ON wiki_sections USING GIN(title gin_trgm_ops);

-- Vector embeddings (384-dim for miniLM)
ALTER TABLE wiki_sections ADD COLUMN embedding vector(384);
CREATE INDEX wiki_sections_embedding_idx ON wiki_sections USING hnsw(embedding vector_cosine_ops);

-- Trigger: populate search_vector on insert/update
CREATE OR REPLACE FUNCTION populate_search_vector() RETURNS TRIGGER AS $$
BEGIN
    NEW.search_vector :=
        setweight(to_tsvector('english', COALESCE(NEW.title, '')), 'A') ||
        setweight(to_tsvector('english', COALESCE(NEW.content, '')), 'B') ||
        setweight(to_tsvector('simple', COALESCE(array_to_string(NEW.tags, ' '), '')), 'C');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER wiki_sections_search_trigger
    BEFORE INSERT OR UPDATE ON wiki_sections
    FOR EACH ROW
    EXECUTE FUNCTION populate_search_vector();

-- Backlinks (what sections link to this one)
CREATE TABLE section_links (
    id SERIAL PRIMARY KEY,
    from_wiki_id VARCHAR(50) NOT NULL,
    from_key VARCHAR(255) NOT NULL,
    to_wiki_id VARCHAR(50) NOT NULL,
    to_key VARCHAR(255) NOT NULL,
    UNIQUE(from_wiki_id, from_key, to_wiki_id, to_key)
);

CREATE INDEX section_links_to_idx ON section_links(to_wiki_id, to_key);
CREATE INDEX section_links_from_idx ON section_links(from_wiki_id, from_key);

-- Version history
CREATE TABLE section_history (
    id SERIAL PRIMARY KEY,
    wiki_id VARCHAR(50) NOT NULL,
    section_key VARCHAR(255) NOT NULL,
    content_before TEXT,
    content_after TEXT NOT NULL,
    changed_at TIMESTAMPTZ DEFAULT NOW(),
    change_reason VARCHAR(100)
);

CREATE INDEX section_history_lookup_idx ON section_history(wiki_id, section_key, changed_at DESC);

-- Trigger: auto-log history on content changes
CREATE OR REPLACE FUNCTION log_section_history() RETURNS TRIGGER AS $$
BEGIN
    IF OLD.content IS DISTINCT FROM NEW.content THEN
        INSERT INTO section_history (wiki_id, section_key, content_before, content_after, change_reason)
        VALUES (NEW.wiki_id, NEW.key, OLD.content, NEW.content, 'update');
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER wiki_sections_history_trigger
    AFTER UPDATE ON wiki_sections
    FOR EACH ROW
    EXECUTE FUNCTION log_section_history();

-- Trigger: auto-populate backlinks from [[wiki-key]] patterns in content
CREATE OR REPLACE FUNCTION extract_backlinks() RETURNS TRIGGER AS $$
DECLARE
    link_match RECORD;
    target_wiki_id VARCHAR(50);
    target_key VARCHAR(255);
BEGIN
    -- Delete existing backlinks from this section
    DELETE FROM section_links
    WHERE from_wiki_id = NEW.wiki_id AND from_key = NEW.key;

    -- Extract [[wiki-key]] patterns from content
    FOR link_match IN
        SELECT match[1] as raw_link
        FROM regexp_matches(NEW.content, '\[\[([a-z0-9_-]+)\]\]', 'g') AS t(match)
    LOOP
        target_key := link_match.raw_link;

        -- Check if the target section exists
        SELECT wiki_id INTO target_wiki_id
        FROM wiki_sections
        WHERE key = target_key
        LIMIT 1;

        IF FOUND THEN
            INSERT INTO section_links (from_wiki_id, from_key, to_wiki_id, to_key)
            VALUES (NEW.wiki_id, NEW.key, target_wiki_id, target_key)
            ON CONFLICT DO NOTHING;
        END IF;
    END LOOP;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER wiki_sections_backlinks_trigger
    AFTER INSERT OR UPDATE ON wiki_sections
    FOR EACH ROW
    EXECUTE FUNCTION extract_backlinks();
