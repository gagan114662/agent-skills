-- Revert #246 per-workspace fleet model column. The `claude-fable-5` → `claude-opus-4-8` data rewrite
-- is intentionally NOT reverted (restoring an unservable model that crashes every session would be a
-- regression); dropping the column removes the override entirely → workspaces fall back to the
-- deployment default `ANTHROPIC_MODEL`.
ALTER TABLE workspace_agent_credentials DROP COLUMN IF EXISTS model;
