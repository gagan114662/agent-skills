-- Revert #231 real-world tool surface receipts.
DROP INDEX IF EXISTS realworld_artifacts_workspace_created_idx;
DROP TABLE IF EXISTS realworld_artifacts;
