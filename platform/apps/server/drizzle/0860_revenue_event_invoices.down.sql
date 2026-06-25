DROP INDEX IF EXISTS revenue_events_invoice_idx;

ALTER TABLE revenue_events
  DROP COLUMN IF EXISTS invoice_status,
  DROP COLUMN IF EXISTS invoice_pdf_url,
  DROP COLUMN IF EXISTS invoice_url,
  DROP COLUMN IF EXISTS invoice_number,
  DROP COLUMN IF EXISTS invoice_id;
