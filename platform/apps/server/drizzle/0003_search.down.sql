-- Reverse of 0003_search.
DROP INDEX IF EXISTS messages_body_tsv_idx;
ALTER TABLE messages DROP COLUMN IF EXISTS body_tsv;
