-- 0504_task_dependencies — task-to-task dependencies / blockers. Issue #515 (extends #14, ADR-0014).
-- A task may depend on (be blocked by) other tasks in the SAME workspace; a blocked task cannot move
-- into in_progress until every blocker is terminal (done/canceled). Reassignment-as-handoff and the
-- artifact links already exist (#14); this migration adds only the dependency edges. Additive.

CREATE TABLE task_dependencies (
  id                   uuid PRIMARY KEY,
  workspace_id         uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- the dependent task (it is blocked) and the task it waits on (the blocker).
  blocked_task_id      uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  blocker_task_id      uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  created_by_member_id uuid REFERENCES members(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  -- an edge is recorded once (idempotent add) and can never point a task at itself.
  CONSTRAINT task_dependencies_uniq UNIQUE (blocked_task_id, blocker_task_id),
  CONSTRAINT task_dependencies_no_self CHECK (blocked_task_id <> blocker_task_id)
);
-- forward: "what blocks task X?"  reverse: "what does task X block?"
CREATE INDEX task_dependencies_blocked_idx ON task_dependencies (blocked_task_id);
CREATE INDEX task_dependencies_blocker_idx ON task_dependencies (blocker_task_id);
-- cycle-check loads the whole workspace graph in one scan.
CREATE INDEX task_dependencies_workspace_idx ON task_dependencies (workspace_id);
