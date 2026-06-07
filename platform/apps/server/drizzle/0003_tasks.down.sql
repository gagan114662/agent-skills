-- Reverse of 0003_tasks. Drop new tables (children first), then the additive tasks columns.
DROP TABLE IF EXISTS task_routing_rules;
DROP TABLE IF EXISTS task_links;
DROP TABLE IF EXISTS task_events;

DROP INDEX IF EXISTS tasks_workspace_assignee_idx;
DROP INDEX IF EXISTS tasks_workspace_status_idx;
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_ck;
ALTER TABLE tasks DROP COLUMN IF EXISTS updated_at;
ALTER TABLE tasks DROP COLUMN IF EXISTS labels;
ALTER TABLE tasks DROP COLUMN IF EXISTS description;
