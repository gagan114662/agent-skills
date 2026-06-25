ALTER TABLE inbound_leads
  ADD COLUMN IF NOT EXISTS email_hash text,
  ADD COLUMN IF NOT EXISTS submitter_hash text,
  ADD COLUMN IF NOT EXISTS verified boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS verification_token_hash text,
  ADD COLUMN IF NOT EXISTS verification_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS verified_at timestamptz;

CREATE INDEX IF NOT EXISTS inbound_leads_workspace_email_hash_idx
  ON inbound_leads (workspace_id, email_hash, created_at);

CREATE INDEX IF NOT EXISTS inbound_leads_verify_token_idx
  ON inbound_leads (verification_token_hash);
