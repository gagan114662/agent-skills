DROP INDEX IF EXISTS agent_workflows_source_workflow_uniq;

ALTER TABLE agent_workflows
  DROP COLUMN IF EXISTS source_workflow_id,
  DROP COLUMN IF EXISTS recurring;
