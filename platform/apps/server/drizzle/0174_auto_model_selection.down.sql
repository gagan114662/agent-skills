-- Down-migration for auto model-selection (0174). Drops the auto-selection "why?" audit column.
ALTER TABLE agent_sessions DROP COLUMN IF EXISTS selection_meta;
