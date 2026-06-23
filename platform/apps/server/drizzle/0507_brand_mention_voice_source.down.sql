ALTER TABLE voice_insights
  DROP CONSTRAINT IF EXISTS voice_insights_source_kind_ck;

ALTER TABLE voice_insights
  ADD CONSTRAINT voice_insights_source_kind_ck
  CHECK (source_kind IN ('support_ticket','checkout_abandon','cancellation','nps'));
