-- 0170_slack_native — Slack-native ipop (issue #170, ADR-0170).
-- Four additive, workspace-scoped tables so the fleet works inside the customer's Slack. No existing
-- table is touched, so a deployment that never connects Slack keeps today's behavior exactly.
-- number-by-issue spacing (0170) to dodge sibling-branch migration-number collisions.
--
-- COMPLIANCE: workspace_slack_connections.workspace_id is the PRIMARY KEY — exactly one Slack app per
-- tenant — mirroring the #68 credentials vault (the never-pool invariant). bot_token AND signing_secret
-- are stored SEALED (AES-256-GCM via crypto/secretbox when AGENT_CREDENTIALS_ENC_KEY is set) and are
-- never returned by any API; only the non-reversible bot_token_fingerprint is surfaced (the UI's
-- "connected" state). slack_events_seen is append-only dedupe (one row per Slack event id). All four
-- tables cascade on workspace delete so disconnecting/deleting a tenant leaves no Slack residue.

-- The per-workspace Slack app connection: sealed bot token + signing secret + connected-state metadata.
CREATE TABLE workspace_slack_connections (
  workspace_id           uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  bot_token              text NOT NULL,                                  -- sealed; never read out by an API
  signing_secret         text NOT NULL,                                  -- sealed; never read out by an API
  bot_token_fingerprint  text NOT NULL,                                  -- non-reversible; UI connected state
  team_id                text,                                           -- the Slack workspace (team) id
  bot_user_id            text,                                           -- the bot's own Slack user id (mention stripping)
  connected_by_member_id uuid REFERENCES members(id) ON DELETE SET NULL, -- audit
  connected_at           timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

-- Maps a Slack channel to the ipop (platform) channel the fleet works in. One link per Slack channel.
CREATE TABLE slack_channel_links (
  id               uuid PRIMARY KEY,
  workspace_id     uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  slack_channel_id text NOT NULL,
  channel_id       uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT slack_channel_links_uniq UNIQUE (workspace_id, slack_channel_id)
);

-- Maps a Slack user to a platform member so approvals/mentions round-trip to a real identity.
CREATE TABLE slack_user_links (
  id            uuid PRIMARY KEY,
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  slack_user_id text NOT NULL,
  member_id     uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT slack_user_links_uniq UNIQUE (workspace_id, slack_user_id)
);

-- Maps a platform thread root (the @mention message) to its Slack thread so agent replies post back
-- in the same Slack thread the human started.
CREATE TABLE slack_thread_links (
  id               uuid PRIMARY KEY,
  workspace_id     uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  root_message_id  uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  slack_channel_id text NOT NULL,
  slack_thread_ts  text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT slack_thread_links_uniq UNIQUE (workspace_id, root_message_id)
);

-- Append-only dedupe ledger: one row per processed Slack event id (Slack retries deliveries).
CREATE TABLE slack_events_seen (
  id             uuid PRIMARY KEY,
  workspace_id   uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  slack_event_id text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT slack_events_seen_uniq UNIQUE (workspace_id, slack_event_id)
);

CREATE INDEX slack_channel_links_channel_idx ON slack_channel_links (channel_id);
CREATE INDEX slack_thread_links_workspace_root_idx ON slack_thread_links (workspace_id, root_message_id);
