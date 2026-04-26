-- 005_fix_key_hash.sql - Widen key_hash column for bcrypt-like hash output

ALTER TABLE api_keys ALTER COLUMN key_hash TYPE TEXT;
