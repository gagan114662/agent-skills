ALTER TABLE delivery_receipts
  DROP CONSTRAINT IF EXISTS delivery_receipts_estimated_cost_cents_ck,
  DROP CONSTRAINT IF EXISTS delivery_receipts_compute_seconds_ck;

ALTER TABLE delivery_receipts
  DROP COLUMN IF EXISTS estimated_cost_cents,
  DROP COLUMN IF EXISTS compute_seconds;
