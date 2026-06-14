-- Additive-only up ⇒ a clean reverse (drop indexes then tables; #189, ADR-0189).
DROP INDEX IF EXISTS acquisition_suppressions_workspace_idx;
DROP TABLE IF EXISTS acquisition_suppressions;
DROP INDEX IF EXISTS acquisition_send_receipts_workspace_channel_idx;
DROP INDEX IF EXISTS acquisition_send_receipts_workspace_created_idx;
DROP TABLE IF EXISTS acquisition_send_receipts;
DROP INDEX IF EXISTS acquisition_budget_envelopes_workspace_status_idx;
DROP TABLE IF EXISTS acquisition_budget_envelopes;
