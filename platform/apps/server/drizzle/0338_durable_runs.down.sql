-- Revert #338 (ADR-0338): drop the durable-workflow runs table and its indexes.
DROP INDEX IF EXISTS durable_runs_workspace_status_idx;
DROP INDEX IF EXISTS durable_runs_idempotency_uk;
DROP TABLE IF EXISTS durable_runs;
