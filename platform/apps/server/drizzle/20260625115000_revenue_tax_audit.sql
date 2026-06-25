ALTER TABLE revenue_events ADD COLUMN IF NOT EXISTS tax_amount_cents integer NOT NULL DEFAULT 0;
ALTER TABLE revenue_events ADD COLUMN IF NOT EXISTS customer_vat_id text;
ALTER TABLE revenue_events ADD COLUMN IF NOT EXISTS effective_tax_rate_bps integer;
