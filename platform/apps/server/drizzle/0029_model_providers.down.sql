-- Reverse of 0029_model_providers.
ALTER TABLE agent_sessions
  DROP CONSTRAINT IF EXISTS agent_sessions_provider_ck,
  DROP CONSTRAINT IF EXISTS agent_sessions_effort_ck,
  DROP CONSTRAINT IF EXISTS agent_sessions_mode_ck;

ALTER TABLE agent_sessions
  DROP COLUMN IF EXISTS provider,
  DROP COLUMN IF EXISTS model,
  DROP COLUMN IF EXISTS effort,
  DROP COLUMN IF EXISTS mode;
