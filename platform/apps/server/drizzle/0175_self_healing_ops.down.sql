-- Down-migration for #193 (ADR-0174). Drops the self-healing remediation ledger.
-- (The flywheel `ops_incident` failure class is a TS-only enum value — no DB object to drop.)
DROP INDEX IF EXISTS self_healing_remediations_open_uk;
DROP INDEX IF EXISTS self_healing_remediations_surface_idx;
DROP INDEX IF EXISTS self_healing_remediations_workspace_status_idx;
DROP TABLE IF EXISTS self_healing_remediations;
