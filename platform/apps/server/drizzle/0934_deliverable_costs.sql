ALTER TABLE delivery_receipts
  ADD COLUMN compute_seconds integer NOT NULL DEFAULT 0,
  ADD COLUMN estimated_cost_cents integer NOT NULL DEFAULT 0;

ALTER TABLE delivery_receipts
  ADD CONSTRAINT delivery_receipts_compute_seconds_ck CHECK (compute_seconds >= 0),
  ADD CONSTRAINT delivery_receipts_estimated_cost_cents_ck CHECK (estimated_cost_cents >= 0);
