-- #904: Reach deliverability receipts for bounce/complaint pause logic.
ALTER TABLE reach_receipts DROP CONSTRAINT IF EXISTS reach_receipts_kind_ck;
ALTER TABLE reach_receipts
  ADD CONSTRAINT reach_receipts_kind_ck
  CHECK (kind IN ('open','reply','booked','bounce','complaint'));
