-- 0858_recurring_autonomy_workflows - let completed template-backed workflows spawn successors.
ALTER TABLE agent_workflows
  ADD COLUMN IF NOT EXISTS recurring boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS source_workflow_id uuid REFERENCES agent_workflows(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS agent_workflows_source_workflow_uniq
  ON agent_workflows (source_workflow_id);
