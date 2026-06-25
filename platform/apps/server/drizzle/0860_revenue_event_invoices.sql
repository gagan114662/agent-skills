ALTER TABLE revenue_events
  ADD COLUMN IF NOT EXISTS invoice_id text,
  ADD COLUMN IF NOT EXISTS invoice_number text,
  ADD COLUMN IF NOT EXISTS invoice_url text,
  ADD COLUMN IF NOT EXISTS invoice_pdf_url text,
  ADD COLUMN IF NOT EXISTS invoice_status text;

CREATE INDEX IF NOT EXISTS revenue_events_invoice_idx
  ON revenue_events (workspace_id, invoice_id);
