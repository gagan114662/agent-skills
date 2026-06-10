-- Rollback SRE Loop (#112).
DROP INDEX IF EXISTS sre_incidents_open_uk;
DROP INDEX IF EXISTS sre_incidents_service_idx;
DROP INDEX IF EXISTS sre_incidents_workspace_status_idx;
DROP TABLE IF EXISTS sre_incidents;
