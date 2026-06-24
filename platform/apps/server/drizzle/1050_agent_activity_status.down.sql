ALTER TABLE agent_sessions
  DROP CONSTRAINT IF EXISTS agent_sessions_agent_status_ck;

ALTER TABLE agent_sessions
  DROP COLUMN IF EXISTS agent_status;

