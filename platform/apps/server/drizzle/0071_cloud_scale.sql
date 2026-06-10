-- 0071_cloud_scale — cloud scale: warm pools, autoscaling, multi-region, cost caps (issue #71, ADR-0040).
-- Per-tenant usage accounting drives the cost/budget cap: each window (a UTC calendar month) accrues
-- sessions launched + compute-seconds + an estimated cost (compute-seconds × a configured rate). The
-- admission chokepoint compares this against the tenant's configured budget. The `region` column
-- records where a session was placed (multi-region). Caps/budget themselves live in config (#58), not
-- here — this table is runtime STATE, the cap is POLICY.

CREATE TABLE tenant_usage (
  workspace_id          uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  window_key            text NOT NULL,                       -- the billing window, UTC 'YYYY-MM'
  sessions_started      integer NOT NULL DEFAULT 0,
  compute_seconds       integer NOT NULL DEFAULT 0,
  estimated_cost_cents  integer NOT NULL DEFAULT 0,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, window_key)
);

CREATE INDEX tenant_usage_workspace_idx ON tenant_usage (workspace_id);

-- Multi-region placement: the region the admission planner chose for a session (NULL = unplaced /
-- local runtime, i.e. the single-region #25 default).
ALTER TABLE agent_sessions ADD COLUMN region text;
