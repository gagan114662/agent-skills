-- Revert #395: drop the outbound-channel connect + receipt ledger (reverse order; receipts first).
DROP INDEX IF EXISTS outbound_send_receipts_approval_idx;
DROP INDEX IF EXISTS outbound_send_receipts_workspace_idx;
DROP TABLE IF EXISTS outbound_send_receipts;
DROP INDEX IF EXISTS outbound_channels_workspace_channel_uk;
DROP TABLE IF EXISTS outbound_channels;
