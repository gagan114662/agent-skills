-- Rollback Fleet Watchdog (#105).
DROP TABLE IF EXISTS watchdog_revivals;
DROP INDEX IF EXISTS agent_sessions_heartbeat_idx;
ALTER TABLE agent_sessions DROP COLUMN IF EXISTS last_heartbeat_at;
