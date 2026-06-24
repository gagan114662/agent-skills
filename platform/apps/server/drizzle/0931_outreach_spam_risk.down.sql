ALTER TABLE outreach_messages
  DROP CONSTRAINT IF EXISTS outreach_messages_spam_risk_level_ck,
  DROP CONSTRAINT IF EXISTS outreach_messages_spam_risk_score_ck,
  DROP COLUMN IF EXISTS spam_risk_reasons,
  DROP COLUMN IF EXISTS spam_risk_level,
  DROP COLUMN IF EXISTS spam_risk_score;
