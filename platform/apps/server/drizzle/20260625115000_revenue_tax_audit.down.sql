ALTER TABLE revenue_events DROP COLUMN IF EXISTS effective_tax_rate_bps;
ALTER TABLE revenue_events DROP COLUMN IF EXISTS customer_vat_id;
ALTER TABLE revenue_events DROP COLUMN IF EXISTS tax_amount_cents;
