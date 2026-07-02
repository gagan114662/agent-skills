CREATE TABLE IF NOT EXISTS intent_monitors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source text NOT NULL,
  label text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  subreddits jsonb NOT NULL DEFAULT '[]'::jsonb,
  keywords jsonb NOT NULL DEFAULT '[]'::jsonb,
  competitors jsonb NOT NULL DEFAULT '[]'::jsonb,
  question_patterns jsonb NOT NULL DEFAULT '[]'::jsonb,
  cadence_minutes integer NOT NULL DEFAULT 15,
  min_score integer NOT NULL DEFAULT 45,
  created_by_member_id uuid REFERENCES members(id) ON DELETE SET NULL,
  last_scanned_at timestamptz,
  next_scan_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT intent_monitors_source_ck CHECK (source IN ('reddit','x')),
  CONSTRAINT intent_monitors_cadence_ck CHECK (cadence_minutes BETWEEN 10 AND 60),
  CONSTRAINT intent_monitors_min_score_ck CHECK (min_score BETWEEN 0 AND 100)
);

CREATE INDEX IF NOT EXISTS intent_monitors_due_idx
  ON intent_monitors (enabled, next_scan_at);

CREATE INDEX IF NOT EXISTS intent_monitors_workspace_idx
  ON intent_monitors (workspace_id, created_at);

CREATE TABLE IF NOT EXISTS intent_leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  monitor_id uuid NOT NULL REFERENCES intent_monitors(id) ON DELETE CASCADE,
  source text NOT NULL,
  external_ref text NOT NULL,
  url text NOT NULL,
  author_label text,
  community text,
  title text NOT NULL,
  body_excerpt text NOT NULL DEFAULT '',
  matched_query text,
  intent_category text NOT NULL,
  intent_score integer NOT NULL,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  matched_signals jsonb NOT NULL DEFAULT '[]'::jsonb,
  draft_reply text NOT NULL,
  status text NOT NULL DEFAULT 'new',
  approval_request_id uuid,
  detected_at timestamptz NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT intent_leads_source_ck CHECK (source IN ('reddit','x')),
  CONSTRAINT intent_leads_category_ck CHECK (intent_category IN ('active_purchase_research','pain_expression','competitor_churn','noise')),
  CONSTRAINT intent_leads_status_ck CHECK (status IN ('new','reply_pending_approval','approved','replied','dismissed')),
  CONSTRAINT intent_leads_score_ck CHECK (intent_score BETWEEN 0 AND 100)
);

CREATE UNIQUE INDEX IF NOT EXISTS intent_leads_external_uk
  ON intent_leads (workspace_id, source, external_ref);

CREATE INDEX IF NOT EXISTS intent_leads_workspace_score_idx
  ON intent_leads (workspace_id, intent_score);

CREATE INDEX IF NOT EXISTS intent_leads_workspace_status_idx
  ON intent_leads (workspace_id, status, updated_at);
