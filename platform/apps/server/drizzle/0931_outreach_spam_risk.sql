-- #931: persist spam/phishing risk scoring per outreach message for audit and review surfacing.

ALTER TABLE outreach_messages
  ADD COLUMN IF NOT EXISTS spam_risk_score integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS spam_risk_level text NOT NULL DEFAULT 'clean',
  ADD COLUMN IF NOT EXISTS spam_risk_reasons jsonb NOT NULL DEFAULT '[]'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'outreach_messages_spam_risk_score_ck'
  ) THEN
    ALTER TABLE outreach_messages
      ADD CONSTRAINT outreach_messages_spam_risk_score_ck CHECK (spam_risk_score BETWEEN 0 AND 100);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'outreach_messages_spam_risk_level_ck'
  ) THEN
    ALTER TABLE outreach_messages
      ADD CONSTRAINT outreach_messages_spam_risk_level_ck CHECK (spam_risk_level IN ('clean','review','block'));
  END IF;
END $$;
