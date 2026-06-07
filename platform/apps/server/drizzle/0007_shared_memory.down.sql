-- Revert 0007_shared_memory (issue #16). Drops in reverse dependency order.

DROP TABLE IF EXISTS memory_files;

DROP INDEX IF EXISTS memories_workspace_live_idx;
ALTER TABLE memories DROP COLUMN IF EXISTS superseded_at;
ALTER TABLE memories DROP COLUMN IF EXISTS superseded_by_memory_id;
