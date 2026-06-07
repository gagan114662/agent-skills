-- 0003_threads_mentions — threaded replies metadata + @mentions. Issue #6, ADR-0006.
-- Additive on top of #2 (messages.parent_message_id already exists) and #4/#5. Safe: the
-- new column has a default, and the new table is independent.

-- "Also send to channel" flag on a thread reply (Slack semantics). Default false → existing
-- rows and root messages are unaffected; clients use it to render the channel/thread split.
ALTER TABLE messages ADD COLUMN also_sent_to_channel boolean NOT NULL DEFAULT false;

-- Mentions extracted from a message body at post time. workspace_id + channel_id are
-- denormalized so "my mentions" / counts are single-table, workspace-scoped reads. The
-- UNIQUE makes extraction idempotent (one mention per member per message).
CREATE TABLE message_mentions (
  id                   uuid PRIMARY KEY,
  workspace_id         uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_id           uuid NOT NULL REFERENCES channels(id)   ON DELETE CASCADE,
  message_id           uuid NOT NULL REFERENCES messages(id)   ON DELETE CASCADE,
  mentioned_member_id  uuid NOT NULL REFERENCES members(id)    ON DELETE CASCADE,
  author_member_id     uuid NOT NULL REFERENCES members(id)    ON DELETE CASCADE,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT message_mentions_uniq UNIQUE (message_id, mentioned_member_id)
);
CREATE INDEX message_mentions_member_idx ON message_mentions (mentioned_member_id, created_at);
