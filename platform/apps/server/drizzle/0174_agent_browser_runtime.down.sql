-- Down: drop the agent browser runtime receipt table (#174, ADR-0174).
DROP INDEX IF EXISTS browser_steps_workspace_created_idx;
DROP INDEX IF EXISTS browser_steps_session_idx;
DROP TABLE IF EXISTS browser_steps;
