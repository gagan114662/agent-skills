CREATE TABLE IF NOT EXISTS monetization_plan_state_changes (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  plan_id uuid REFERENCES monetization_plans(id) ON DELETE SET NULL,
  from_status text NOT NULL,
  to_status text NOT NULL,
  actor_member_id uuid REFERENCES members(id) ON DELETE SET NULL,
  reason text NOT NULL,
  approval_request_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT monetization_plan_state_changes_from_status_ck
    CHECK (from_status IN ('draft','pending_activation','active','archived')),
  CONSTRAINT monetization_plan_state_changes_to_status_ck
    CHECK (to_status IN ('draft','pending_activation','active','archived'))
);

CREATE INDEX IF NOT EXISTS monetization_plan_state_changes_workspace_time_idx
  ON monetization_plan_state_changes (workspace_id, created_at);

CREATE INDEX IF NOT EXISTS monetization_plan_state_changes_plan_time_idx
  ON monetization_plan_state_changes (workspace_id, plan_id, created_at);
