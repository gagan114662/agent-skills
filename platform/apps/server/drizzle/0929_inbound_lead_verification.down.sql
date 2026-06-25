DROP INDEX IF EXISTS inbound_leads_verify_token_idx;
DROP INDEX IF EXISTS inbound_leads_workspace_email_hash_idx;

ALTER TABLE inbound_leads
  DROP COLUMN IF EXISTS verified_at,
  DROP COLUMN IF EXISTS verification_sent_at,
  DROP COLUMN IF EXISTS verification_token_hash,
  DROP COLUMN IF EXISTS verified,
  DROP COLUMN IF EXISTS submitter_hash,
  DROP COLUMN IF EXISTS email_hash;
