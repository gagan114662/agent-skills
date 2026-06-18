-- Revert #365 connection-health marker.
ALTER TABLE workspace_agent_credentials DROP COLUMN IF EXISTS last_auth_failure_at;
