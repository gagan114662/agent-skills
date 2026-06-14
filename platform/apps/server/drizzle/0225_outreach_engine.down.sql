-- Revert #225 outreach engine.
DROP INDEX IF EXISTS outreach_receipts_unique;
DROP INDEX IF EXISTS outreach_receipts_message_idx;
DROP INDEX IF EXISTS outreach_receipts_workspace_idx;
DROP TABLE IF EXISTS outreach_receipts;
DROP INDEX IF EXISTS outreach_messages_experiment_idx;
DROP INDEX IF EXISTS outreach_messages_workspace_created_idx;
DROP TABLE IF EXISTS outreach_messages;
