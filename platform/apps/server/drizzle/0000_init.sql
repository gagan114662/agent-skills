-- 0000_init — core data model (issue #2). Mirrors src/db/schema/*.ts. See ADR-0002.

CREATE TABLE workspaces (
  id          uuid PRIMARY KEY,
  slug        text NOT NULL UNIQUE,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id            uuid PRIMARY KEY,
  email         text NOT NULL UNIQUE,
  display_name  text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agents (
  id             uuid PRIMARY KEY,
  workspace_id   uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  name           text NOT NULL,
  framework      text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE members (
  id            uuid PRIMARY KEY,
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind          text NOT NULL,
  user_id       uuid REFERENCES users(id) ON DELETE CASCADE,
  agent_id      uuid REFERENCES agents(id) ON DELETE CASCADE,
  display_name  text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT members_kind_ck CHECK (kind IN ('human', 'agent')),
  CONSTRAINT members_kind_identity_ck CHECK (
    (kind = 'human' AND user_id IS NOT NULL AND agent_id IS NULL)
    OR (kind = 'agent' AND agent_id IS NOT NULL AND user_id IS NULL)
  )
);

CREATE TABLE channels (
  id            uuid PRIMARY KEY,
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind          text NOT NULL,
  name          text,
  is_archived   boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT channels_kind_ck CHECK (kind IN ('public', 'dm'))
);

CREATE TABLE channel_members (
  channel_id  uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  member_id   uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  joined_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, member_id)
);

CREATE TABLE messages (
  id                 uuid PRIMARY KEY,
  workspace_id       uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_id         uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  author_member_id   uuid NOT NULL REFERENCES members(id),
  parent_message_id  uuid REFERENCES messages(id) ON DELETE CASCADE,
  body               text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  edited_at          timestamptz,
  deleted_at         timestamptz
);
CREATE INDEX messages_channel_created_idx ON messages (channel_id, created_at);
CREATE INDEX messages_parent_idx ON messages (parent_message_id);

-- stub tables (extended by #14 / #15 / #9) --

CREATE TABLE tasks (
  id                    uuid PRIMARY KEY,
  workspace_id          uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title                 text NOT NULL,
  status                text NOT NULL DEFAULT 'backlog',
  assignee_member_id    uuid REFERENCES members(id) ON DELETE SET NULL,
  created_by_member_id  uuid REFERENCES members(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memories (
  id            uuid PRIMARY KEY,
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  type          text NOT NULL,
  content       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memory_edges (
  id              uuid PRIMARY KEY,
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  from_memory_id  uuid NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  to_memory_id    uuid NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  relation        text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE permissions (
  id             uuid PRIMARY KEY,
  workspace_id   uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  member_id      uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  resource_type  text NOT NULL,
  resource_id    uuid,
  capability     text NOT NULL,
  CONSTRAINT permissions_capability_ck CHECK (capability IN ('read', 'write', 'propagate'))
);
