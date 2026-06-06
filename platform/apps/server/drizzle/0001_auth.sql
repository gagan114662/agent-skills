-- 0001_auth — authentication for humans (sessions) and agents (tokens). Issue #3, ADR-0003.

ALTER TABLE users ADD COLUMN password_hash text;

CREATE TABLE sessions (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE agent_tokens (
  id            uuid PRIMARY KEY,
  agent_id      uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  token_hash    text NOT NULL UNIQUE,
  name          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz
);
CREATE INDEX agent_tokens_agent_idx ON agent_tokens (agent_id);
