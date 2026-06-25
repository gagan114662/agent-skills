DROP INDEX IF EXISTS agent_workflows_current_session_idx;

ALTER TABLE agent_workflows
  DROP COLUMN IF EXISTS current_session_stage,
  DROP COLUMN IF EXISTS current_session_id;

DROP INDEX IF EXISTS agent_sessions_workspace_idempotency_uniq;

ALTER TABLE agent_sessions
  DROP COLUMN IF EXISTS idempotency_key;
