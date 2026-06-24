ALTER TABLE reach_receipts DROP COLUMN IF EXISTS reply_subject;
ALTER TABLE reach_receipts DROP COLUMN IF EXISTS reply_from;
ALTER TABLE reach_receipts DROP COLUMN IF EXISTS reply_body;

ALTER TABLE outreach_receipts DROP COLUMN IF EXISTS reply_subject;
ALTER TABLE outreach_receipts DROP COLUMN IF EXISTS reply_from;
ALTER TABLE outreach_receipts DROP COLUMN IF EXISTS reply_body;
