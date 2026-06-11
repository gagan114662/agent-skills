-- Marketing Department Fleet (#123, ADR-0123): durable task records for the seeded agency.
-- Additive + idempotent — no change to any existing table, so a sibling-branch migration sharing the
-- Conductor Postgres can't collide. Numbered 0123 by issue (not a monotonic counter) per ADR-0099/0105.

-- Each welcome brief and each @mention launch becomes a row tying the channel + agent + the launched
-- #25 session + (for a mention) its source message. session_id/message_id are SOFT references (no FK)
-- so a record outlives pruned session/message history; only workspace_id carries the #3 tenant boundary.
CREATE TABLE IF NOT EXISTS marketing_tasks (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  department text NOT NULL,
  agent_member_id uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  session_id uuid,
  message_id uuid,
  kind text NOT NULL,
  task text NOT NULL,
  status text NOT NULL DEFAULT 'launched',
  created_by_member_id uuid REFERENCES members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT marketing_tasks_kind_ck CHECK (kind IN ('welcome','mention')),
  CONSTRAINT marketing_tasks_status_ck CHECK (status IN ('launched','done','failed','blocked'))
);

CREATE INDEX IF NOT EXISTS marketing_tasks_workspace_idx ON marketing_tasks (workspace_id, created_at);
CREATE INDEX IF NOT EXISTS marketing_tasks_agent_idx ON marketing_tasks (workspace_id, agent_member_id);
