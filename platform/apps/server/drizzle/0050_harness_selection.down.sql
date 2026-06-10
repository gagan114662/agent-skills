-- Reverse of 0050_harness_selection.
ALTER TABLE agent_sessions
  DROP CONSTRAINT IF EXISTS agent_sessions_harness_ck;

ALTER TABLE agent_sessions
  DROP COLUMN IF EXISTS harness;
