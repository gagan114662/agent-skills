ALTER TABLE outreach_receipts ADD COLUMN IF NOT EXISTS reply_body text;
ALTER TABLE outreach_receipts ADD COLUMN IF NOT EXISTS reply_from text;
ALTER TABLE outreach_receipts ADD COLUMN IF NOT EXISTS reply_subject text;

ALTER TABLE reach_receipts ADD COLUMN IF NOT EXISTS reply_body text;
ALTER TABLE reach_receipts ADD COLUMN IF NOT EXISTS reply_from text;
ALTER TABLE reach_receipts ADD COLUMN IF NOT EXISTS reply_subject text;
