CREATE TABLE IF NOT EXISTS deliverable_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  delivery_receipt_id uuid NOT NULL REFERENCES delivery_receipts(id) ON DELETE CASCADE,
  rating integer NOT NULL,
  category text NOT NULL DEFAULT 'other',
  comment text,
  alert_notified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT deliverable_feedback_rating_ck CHECK (rating BETWEEN 1 AND 5),
  CONSTRAINT deliverable_feedback_category_ck CHECK (category IN ('helpful','off_brand','inaccurate','unclear','other'))
);

CREATE INDEX IF NOT EXISTS deliverable_feedback_workspace_created_idx
  ON deliverable_feedback (workspace_id, created_at);

CREATE INDEX IF NOT EXISTS deliverable_feedback_receipt_idx
  ON deliverable_feedback (delivery_receipt_id);

CREATE INDEX IF NOT EXISTS deliverable_feedback_low_rating_idx
  ON deliverable_feedback (workspace_id, rating, created_at);
