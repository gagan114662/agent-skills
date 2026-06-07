-- 0004_tasks — Linear-style task system. Issue #14, ADR-0014.
-- (Renamed from 0003_tasks → 0004_tasks: #7 search landed 0003_search on main first.)
-- Additive: extends the #2 `tasks` stub (0000_init) with description/labels/updated_at
-- and a status CHECK, then adds the coordination tables (events, links, routing rules).

-- 1. Extend tasks. Existing rows get the column defaults; the lifecycle CHECK matches
--    src/tasks/status.ts and the schema enum.
ALTER TABLE tasks ADD COLUMN description text;
ALTER TABLE tasks ADD COLUMN labels jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE tasks ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE tasks
  ADD CONSTRAINT tasks_status_ck
  CHECK (status IN ('backlog','todo','in_progress','blocked','done','canceled'));
CREATE INDEX tasks_workspace_status_idx   ON tasks (workspace_id, status);
CREATE INDEX tasks_workspace_assignee_idx ON tasks (workspace_id, assignee_member_id);

-- 2. Append-only audit log. Assignment/status history is derived from these rows.
CREATE TABLE task_events (
  id               uuid PRIMARY KEY,
  workspace_id     uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id          uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  type             text NOT NULL,
  actor_member_id  uuid REFERENCES members(id) ON DELETE SET NULL,
  from_value       text,
  to_value         text,
  detail           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX task_events_task_created_idx ON task_events (task_id, created_at);

-- 3. Polymorphic links (message/memory now; file later). UNIQUE makes link idempotent;
--    the reverse index serves "which tasks reference this object?".
CREATE TABLE task_links (
  id                   uuid PRIMARY KEY,
  workspace_id         uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id              uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  target_type          text NOT NULL,
  target_id            uuid NOT NULL,
  created_by_member_id uuid REFERENCES members(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT task_links_task_target_uniq UNIQUE (task_id, target_type, target_id)
);
CREATE INDEX task_links_reverse_idx ON task_links (workspace_id, target_type, target_id);

-- 4. Auto-routing rules: label -> eligible agent member.
CREATE TABLE task_routing_rules (
  id                   uuid PRIMARY KEY,
  workspace_id         uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  label                text NOT NULL,
  agent_member_id      uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  created_by_member_id uuid REFERENCES members(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT task_routing_rules_uniq UNIQUE (workspace_id, label, agent_member_id)
);
CREATE INDEX task_routing_rules_label_idx ON task_routing_rules (workspace_id, label);
