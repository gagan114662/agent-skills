-- 0003_search — full-text search over messages (issue #7, ADR-0007).
-- Additive: no new table, no behavior change for existing routes. Adds a generated
-- tsvector column + GIN index so search is ranked, indexed, and self-maintaining.

-- GENERATED ALWAYS … STORED: Postgres recomputes body_tsv on every INSERT/UPDATE of
-- `body` and drops the index entry on DELETE — so the FTS index stays correct across
-- edits and deletes with zero maintenance code (no trigger, no app-side denormalization).
-- Soft-deleted rows (deleted_at) are excluded at query time, not here.
ALTER TABLE messages
  ADD COLUMN body_tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('english', body)) STORED;

-- GIN index supports `body_tsv @@ websearch_to_tsquery(...)` and ts_rank ranking.
CREATE INDEX messages_body_tsv_idx ON messages USING GIN (body_tsv);
