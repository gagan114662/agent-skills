-- Self-Shipping Loop (#172, ADR-0172): agent-ok issues → cloud build agents → auto-review → auto-merge
-- within guardrails → rebase-train → post-merge verify. Numbered 0172 by ISSUE (per ADR-0099, to dodge
-- sibling-workspace collisions in the shared migration sequence). Tenant boundary: workspace_id (#3).
CREATE TABLE IF NOT EXISTS build_loop_runs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  issue_ref text NOT NULL,
  issue_title text NOT NULL,
  priority integer NOT NULL DEFAULT 0,
  depends_on text,
  agent_ok boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'queued',
  review_rounds integer NOT NULL DEFAULT 0,
  build_session_id uuid,
  pr_ref text,
  pr_head_branch text,
  merge_ref text,
  escalation_reason text,
  target_channel_id uuid,
  target_agent_member_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT build_loop_runs_status_ck
    CHECK (status IN ('queued','building','reviewing','revising','merging','merged','escalated','failed')),
  CONSTRAINT build_loop_runs_issue_uk UNIQUE (workspace_id, issue_ref)
);
CREATE INDEX IF NOT EXISTS build_loop_runs_workspace_status_idx
  ON build_loop_runs (workspace_id, status);

CREATE TABLE IF NOT EXISTS build_loop_reviews (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES build_loop_runs(id) ON DELETE CASCADE,
  round integer NOT NULL,
  verdict text NOT NULL,
  summary text NOT NULL DEFAULT '',
  findings text NOT NULL DEFAULT '',
  reviewer_session_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT build_loop_reviews_verdict_ck CHECK (verdict IN ('pass','fail'))
);
CREATE INDEX IF NOT EXISTS build_loop_reviews_run_idx ON build_loop_reviews (run_id);
CREATE INDEX IF NOT EXISTS build_loop_reviews_workspace_idx ON build_loop_reviews (workspace_id);
