ALTER TABLE outreach_messages
  ADD COLUMN IF NOT EXISTS external_id text;
