CREATE TABLE IF NOT EXISTS deliverable_performance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  delivery_receipt_id uuid NOT NULL REFERENCES delivery_receipts(id) ON DELETE CASCADE,
  source text NOT NULL DEFAULT 'manual',
  views integer NOT NULL DEFAULT 0,
  engagements integer NOT NULL DEFAULT 0,
  conversions integer NOT NULL DEFAULT 0,
  external_metric_ref text,
  measured_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT deliverable_performance_source_ck CHECK (source IN ('analytics','search_console','provider','manual')),
  CONSTRAINT deliverable_performance_views_ck CHECK (views >= 0),
  CONSTRAINT deliverable_performance_engagements_ck CHECK (engagements >= 0),
  CONSTRAINT deliverable_performance_conversions_ck CHECK (conversions >= 0)
);

CREATE INDEX IF NOT EXISTS deliverable_performance_workspace_measured_idx
  ON deliverable_performance (workspace_id, measured_at);

CREATE INDEX IF NOT EXISTS deliverable_performance_receipt_measured_idx
  ON deliverable_performance (delivery_receipt_id, measured_at);
