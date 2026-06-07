-- Reverse of 0003_memory. Returns memories / memory_edges to their #2 stub shape.
DROP INDEX IF EXISTS memory_edges_to_idx;
DROP INDEX IF EXISTS memory_edges_from_idx;
ALTER TABLE memory_edges DROP CONSTRAINT IF EXISTS memory_edges_uniq;
ALTER TABLE memory_edges DROP COLUMN IF EXISTS created_by_member_id;

DROP INDEX IF EXISTS memories_workspace_entity_idx;
DROP INDEX IF EXISTS memories_workspace_type_idx;
ALTER TABLE memories DROP CONSTRAINT IF EXISTS memories_workspace_dedupe_uniq;
ALTER TABLE memories DROP CONSTRAINT IF EXISTS memories_source_type_ck;
ALTER TABLE memories DROP COLUMN IF EXISTS created_by_member_id;
ALTER TABLE memories DROP COLUMN IF EXISTS dedupe_key;
ALTER TABLE memories DROP COLUMN IF EXISTS source_id;
ALTER TABLE memories DROP COLUMN IF EXISTS source_type;
ALTER TABLE memories DROP COLUMN IF EXISTS entity;
