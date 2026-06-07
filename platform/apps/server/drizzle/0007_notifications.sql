-- 0007_notifications — notifications inbox + per-member preferences. Issue #8, ADR-0008.
-- Additive on top of #6 (mentions), #4/#5 (channels/messages/realtime), #9 (RBAC), #14 (tasks).
-- Two new independent tables; no existing table is touched. Numbered 0007 — the next free number
-- after 0006_threads_mentions (0025_agent_sessions is a sibling branch's reserved number).

-- A durable, per-recipient record of an activity (mention / dm / reply / assignment; `approval`
-- reserved for a future approval primitive — no trigger emits it yet). workspace_id + the
-- reference columns are denormalized so the inbox + unread count are single-table, workspace- and
-- recipient-scoped reads. `excerpt` is a snapshot so the inbox renders without joins and survives
-- source deletion. read_at IS NULL ⇔ unread.
CREATE TABLE notifications (
  id                   uuid PRIMARY KEY,
  workspace_id         uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  recipient_member_id  uuid NOT NULL REFERENCES members(id)    ON DELETE CASCADE,
  type                 text NOT NULL,
  actor_member_id      uuid REFERENCES members(id)  ON DELETE SET NULL,
  channel_id           uuid REFERENCES channels(id) ON DELETE CASCADE,
  message_id           uuid REFERENCES messages(id) ON DELETE CASCADE,
  task_id              uuid REFERENCES tasks(id)    ON DELETE CASCADE,
  excerpt              text,
  read_at              timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now()
);
-- inbox: a recipient's notifications, newest first
CREATE INDEX notifications_recipient_idx ON notifications (recipient_member_id, created_at);
-- fast unread count / unread filter
CREATE INDEX notifications_unread_idx ON notifications (recipient_member_id) WHERE read_at IS NULL;

-- Per-member notification preferences. muted silences all; mention_only keeps only mentions.
-- A member belongs to exactly one workspace, so member_id is the natural key; workspace_id is
-- denormalized for workspace-scoped consistency.
CREATE TABLE notification_preferences (
  member_id    uuid PRIMARY KEY REFERENCES members(id)    ON DELETE CASCADE,
  workspace_id uuid NOT NULL    REFERENCES workspaces(id) ON DELETE CASCADE,
  muted        boolean NOT NULL DEFAULT false,
  mention_only boolean NOT NULL DEFAULT false,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
