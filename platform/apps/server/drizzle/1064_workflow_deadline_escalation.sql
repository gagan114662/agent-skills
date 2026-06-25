ALTER TABLE agent_workflows
  ADD COLUMN max_age_ms integer NOT NULL DEFAULT 86400000,
  ADD COLUMN deadline_at timestamptz;

CREATE INDEX agent_workflows_workspace_deadline_idx
  ON agent_workflows (workspace_id, deadline_at);
