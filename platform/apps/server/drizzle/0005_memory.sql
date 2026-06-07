-- 0005_memory — typed context/memory graph (issue #15, ADR-0015).
-- Makes the #2 `memories` / `memory_edges` stubs (0000_init) live: typed nodes with
-- provenance + a dedup key, and idempotent typed edges with traversal indexes.
--
-- Additive + reversible (paired 0005_memory.down.sql). `type` / `relation` stay free text
-- (extensible); the canonical sets live in the app layer, not a DB CHECK.

-- nodes --
ALTER TABLE memories ADD COLUMN entity text;
ALTER TABLE memories ADD COLUMN source_type text;
ALTER TABLE memories ADD COLUMN source_id uuid;
-- Nullable: #14's createMemory() task-link shim inserts memories without a dedup key (a NULL
-- never collides under the UNIQUE below), while the #15 graph's own writes always supply one.
ALTER TABLE memories ADD COLUMN dedupe_key text;
ALTER TABLE memories ADD COLUMN created_by_member_id uuid REFERENCES members(id) ON DELETE SET NULL;
ALTER TABLE memories ADD CONSTRAINT memories_source_type_ck
  CHECK (source_type IS NULL OR source_type IN ('message', 'task', 'file', 'event', 'manual'));
-- one node per (workspace, dedupe_key): lets a write be an idempotent merge.
ALTER TABLE memories ADD CONSTRAINT memories_workspace_dedupe_uniq UNIQUE (workspace_id, dedupe_key);
CREATE INDEX memories_workspace_type_idx ON memories (workspace_id, type);
CREATE INDEX memories_workspace_entity_idx ON memories (workspace_id, entity);

-- edges --
ALTER TABLE memory_edges ADD COLUMN created_by_member_id uuid REFERENCES members(id) ON DELETE SET NULL;
ALTER TABLE memory_edges ADD CONSTRAINT memory_edges_uniq
  UNIQUE (workspace_id, from_memory_id, to_memory_id, relation);
CREATE INDEX memory_edges_from_idx ON memory_edges (from_memory_id);
CREATE INDEX memory_edges_to_idx ON memory_edges (to_memory_id);
