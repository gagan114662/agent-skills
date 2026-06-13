-- Agent Browser Runtime (#174, ADR-0174): give each agent session its own Playwright-driven Chromium,
-- with approval-gated side-effects and receipts. Numbered 0174 by ISSUE (per ADR-0099, to dodge
-- sibling-workspace collisions in the shared migration sequence). Tenant boundary: workspace_id (#3).
--
-- ONE table — `browser_steps`, the receipt / "why?" audit trail. EVERY browser step (allowed, denied,
-- or awaiting a #13 approval) writes one row: the URL it touched, the action, the decision, the #13
-- approval id (when gated), and a screenshot path (a deliverable attachment). This is bookkeeping about
-- what the browser did — it holds NO authority over any business table. The browser caps + domain lists
-- live in the layered config (#58), not here; the approval lifecycle lives in approval_requests (#13).
CREATE TABLE IF NOT EXISTS browser_steps (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- The runtime/agent session that drove the browser. No FK: a smoke/preflight session need not be a
  -- persisted agent_sessions row, and the workspace_id FK already carries the #3 tenant boundary.
  session_id uuid NOT NULL,
  step_no integer NOT NULL,                       -- 1-based order the agent drove the browser
  tool text NOT NULL,                             -- one of the seven scoped tools
  url text,                                        -- the URL the step touched (nullable)
  side_effectful boolean NOT NULL,
  decision text NOT NULL,                          -- allow | deny | needs_approval | forbidden | disabled
  approval_request_id text,                        -- the #13 request id when gated (nullable)
  screenshot_path text,                            -- a scrubbed screenshot path (never a token-bearing URL)
  bytes bigint NOT NULL DEFAULT 0,                 -- bytes transferred by this step (bandwidth audit)
  detail text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT browser_steps_tool_ck
    CHECK (tool IN ('navigate','read_page','screenshot','scroll','wait','click','type')),
  CONSTRAINT browser_steps_decision_ck
    CHECK (decision IN ('allow','deny','needs_approval','forbidden','disabled'))
);

-- The receipt stream for one session, in order; and the tenant-scoped recent feed for the console.
CREATE INDEX IF NOT EXISTS browser_steps_session_idx
  ON browser_steps (workspace_id, session_id, step_no);
CREATE INDEX IF NOT EXISTS browser_steps_workspace_created_idx
  ON browser_steps (workspace_id, created_at DESC);
