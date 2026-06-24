-- 0522_support_ticket_csat — CSAT-gated support learning (issue #920).
-- Additive fields on the existing support_tickets inbox. These let the support desk distinguish
-- owner-verified happy resolutions from merely closed tickets before promoting a reply into the KB.
ALTER TABLE support_tickets
  ADD COLUMN IF NOT EXISTS csat_score integer,
  ADD COLUMN IF NOT EXISTS csat_comment text,
  ADD COLUMN IF NOT EXISTS csat_submitted_at timestamptz;

ALTER TABLE support_tickets
  ADD CONSTRAINT support_tickets_csat_score_ck CHECK (csat_score IS NULL OR csat_score BETWEEN 1 AND 5);
