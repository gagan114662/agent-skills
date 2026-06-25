-- 0855_autonomy_session_recovery - make autonomy stage launches restart-idempotent.
ALTER TABLE agent_sessions
  ADD COLUMN IF NOT EXISTS idempotency_key text;

CREATE UNIQUE INDEX IF NOT EXISTS agent_sessions_workspace_idempotency_uniq
  ON agent_sessions (workspace_id, idempotency_key);

ALTER TABLE agent_workflows
  ADD COLUMN IF NOT EXISTS current_session_id uuid REFERENCES agent_sessions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS current_session_stage integer;

CREATE INDEX IF NOT EXISTS agent_workflows_current_session_idx
  ON agent_workflows (current_session_id);
