-- Revert #280 Reach outbound demand-gen department.
DROP INDEX IF EXISTS reach_runs_workspace_created_idx;
DROP TABLE IF EXISTS reach_runs;

DROP INDEX IF EXISTS reach_receipts_unique;
DROP INDEX IF EXISTS reach_receipts_send_idx;
DROP INDEX IF EXISTS reach_receipts_workspace_idx;
DROP TABLE IF EXISTS reach_receipts;

DROP INDEX IF EXISTS reach_sends_contact_idx;
DROP INDEX IF EXISTS reach_sends_workspace_created_idx;
DROP TABLE IF EXISTS reach_sends;

DROP INDEX IF EXISTS reach_contacts_workspace_status_idx;
DROP INDEX IF EXISTS reach_contacts_unique;
DROP TABLE IF EXISTS reach_contacts;
