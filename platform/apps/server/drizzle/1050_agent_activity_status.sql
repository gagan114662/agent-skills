-- 1050_agent_activity_status — per-agent live activity state for the coordination feed.
ALTER TABLE agent_sessions
  ADD COLUMN IF NOT EXISTS agent_status text NOT NULL DEFAULT 'idle';

ALTER TABLE agent_sessions
  DROP CONSTRAINT IF EXISTS agent_sessions_agent_status_ck;

ALTER TABLE agent_sessions
  ADD CONSTRAINT agent_sessions_agent_status_ck
  CHECK (agent_status IN ('thinking', 'drafting', 'waiting', 'handoff', 'idle', 'done'));

