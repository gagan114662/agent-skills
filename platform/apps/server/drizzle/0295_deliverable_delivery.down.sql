-- Revert #295 (ADR-0295): drop the deliverable delivery receipts table and its indexes.
DROP INDEX IF EXISTS delivery_receipts_approval_idx;
DROP INDEX IF EXISTS delivery_receipts_workspace_shipped_idx;
DROP TABLE IF EXISTS delivery_receipts;
