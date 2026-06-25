DROP INDEX IF EXISTS agent_workflows_workspace_deadline_idx;

ALTER TABLE agent_workflows
  DROP COLUMN IF EXISTS deadline_at,
  DROP COLUMN IF EXISTS max_age_ms;
