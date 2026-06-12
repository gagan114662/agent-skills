-- Down-migration for #173 (ADR-0173). Drops the Founder Briefings delivery audit table.
DROP INDEX IF EXISTS founder_briefings_workspace_idx;
DROP TABLE IF EXISTS founder_briefings;
