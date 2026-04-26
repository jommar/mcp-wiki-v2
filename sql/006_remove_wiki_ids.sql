-- 006_remove_wiki_ids.sql - Drop wiki_ids scoping from api_keys (not enforced)
ALTER TABLE api_keys DROP COLUMN IF EXISTS wiki_ids;
