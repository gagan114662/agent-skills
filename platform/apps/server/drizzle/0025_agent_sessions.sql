-- 0025_agent_sessions — cloud agent execution (issue #25, ADR-0025).
-- A server-owned record of an agent run on an AgentRuntime backend (local | sandbox).
-- Created when a session is launched, advanced through its lifecycle by the SessionManager,
-- and finalized at teardown. This is what makes "close the laptop, agents keep working" real:
-- the row (and the streamed messages) outlive any client connection.

CREATE TABLE agent_sessions (
  id                    uuid PRIMARY KEY,
  workspace_id          uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_id            uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  -- the agent member the session runs as / posts as
  agent_member_id       uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  -- the member (human or agent) that launched it; nullable so a launcher can be removed
  created_by_member_id  uuid REFERENCES members(id) ON DELETE SET NULL,
  runtime               text NOT NULL,   -- 'local' | 'sandbox'
  status                text NOT NULL DEFAULT 'provisioning',
  command               text NOT NULL,
  sandbox_id            text,            -- provider sandbox id (sandbox backend only)
  snapshot_id           text,            -- snapshot captured at teardown (fast resume)
  exit_code             integer,
  result                text,            -- terminal summary / output tail (never secrets)
  caps                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at            timestamptz,
  ended_at              timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_sessions_runtime_ck CHECK (runtime IN ('local', 'sandbox')),
  CONSTRAINT agent_sessions_status_ck CHECK (
    status IN ('provisioning', 'running', 'completed', 'failed', 'timeout', 'idle_reaped', 'canceled')
  )
);

CREATE INDEX agent_sessions_workspace_idx ON agent_sessions (workspace_id);
CREATE INDEX agent_sessions_channel_idx ON agent_sessions (channel_id, created_at);
-- the idle reaper / sweep scans non-terminal sessions
CREATE INDEX agent_sessions_status_idx ON agent_sessions (status);
