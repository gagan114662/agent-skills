-- 0007_shared_memory — shared memory access + task/file linking (issue #16, ADR-0016).
-- Builds on #15 (memories/memory_edges) and #14 (task_links). Additive + reversible
-- (paired 0007_shared_memory.down.sql).
--
-- Two changes, both additive:
--   1. supersede/version — a node can be marked stale by a newer one (kept, not deleted).
--   2. memory_files — link a memory node to a file path (no files table yet; path is the id).
--
-- RBAC reuses the #9 `permissions` table as-is: resource_type='memory', resource_id=workspace_id
-- (resource_type is free text), so no schema change is needed for shared, governable access.

-- supersede / version --
ALTER TABLE memories ADD COLUMN superseded_by_memory_id uuid REFERENCES memories(id) ON DELETE SET NULL;
ALTER TABLE memories ADD COLUMN superseded_at timestamptz;
-- the default-list "live nodes" path filters on this; partial index keeps it cheap per workspace.
CREATE INDEX memories_workspace_live_idx ON memories (workspace_id) WHERE superseded_by_memory_id IS NULL;

-- memory ↔ file links (id supplied by the app via newId(), matching every other table) --
CREATE TABLE memory_files (
  id                   uuid PRIMARY KEY,
  workspace_id         uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  memory_id            uuid NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  path                 text NOT NULL,
  created_by_member_id uuid REFERENCES members(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT memory_files_uniq UNIQUE (workspace_id, memory_id, path)
);
-- forward (by memory) and reverse (by path) resolution.
CREATE INDEX memory_files_memory_idx ON memory_files (memory_id);
CREATE INDEX memory_files_reverse_idx ON memory_files (workspace_id, path);
