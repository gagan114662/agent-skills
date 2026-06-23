-- Issue #613: capture the first paid conversion as a reusable case-study draft.
CREATE TABLE IF NOT EXISTS first_customer_stories (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE cascade,
  revenue_event_id uuid NOT NULL REFERENCES revenue_events(id) ON DELETE cascade,
  channel_id uuid REFERENCES channels(id) ON DELETE set null,
  session_id uuid REFERENCES agent_sessions(id) ON DELETE set null,
  provider_event_id text NOT NULL,
  amount_cents integer NOT NULL,
  currency text NOT NULL,
  case_study_draft text NOT NULL,
  celebration_title text NOT NULL,
  celebration_message text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS first_customer_stories_workspace_uq
  ON first_customer_stories(workspace_id);

CREATE INDEX IF NOT EXISTS first_customer_stories_revenue_event_idx
  ON first_customer_stories(revenue_event_id);
