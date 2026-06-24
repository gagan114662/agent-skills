-- Down for 0522_support_ticket_csat (#920).
ALTER TABLE support_tickets DROP CONSTRAINT IF EXISTS support_tickets_csat_score_ck;

ALTER TABLE support_tickets
  DROP COLUMN IF EXISTS csat_submitted_at,
  DROP COLUMN IF EXISTS csat_comment,
  DROP COLUMN IF EXISTS csat_score;
