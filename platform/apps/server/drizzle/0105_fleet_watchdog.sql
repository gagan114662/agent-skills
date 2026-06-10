-- Fleet Watchdog (#105, ADR-0105): detect, revive, and escalate stalled agent sessions.
-- (1) a liveness heartbeat on agent_sessions; (2) a durable revival-lineage table.

-- (1) Heartbeat: bumped by the SessionManager on every output chunk; the watchdog flags a
-- non-terminal session whose heartbeat is older than its stale cutoff. Additive + nullable, so
-- existing rows are unaffected (staleness falls back to started_at / created_at).
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS last_heartbeat_at timestamptz;

-- Keep the watchdog's "non-terminal sessions by liveness" scan cheap.
CREATE INDEX IF NOT EXISTS agent_sessions_heartbeat_idx
  ON agent_sessions (status, last_heartbeat_at);

-- (2) Durable revival lineage: the bounded restart policy survives a process restart. Session-id
-- columns are soft references (no FK) so the lineage outlives pruned session history; only
-- workspace_id carries the #3 tenant boundary.
CREATE TABLE IF NOT EXISTS watchdog_revivals (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  root_session_id uuid NOT NULL,
  current_session_id uuid NOT NULL,
  revivals integer NOT NULL DEFAULT 0,
  window_started_at timestamptz NOT NULL DEFAULT now(),
  last_revival_at timestamptz,
  last_error_class text,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT watchdog_revivals_status_ck
    CHECK (status IN ('active','escalated','recovered')),
  CONSTRAINT watchdog_revivals_root_uk UNIQUE (workspace_id, root_session_id)
);
CREATE INDEX IF NOT EXISTS watchdog_revivals_workspace_status_idx
  ON watchdog_revivals (workspace_id, status);
CREATE INDEX IF NOT EXISTS watchdog_revivals_current_session_idx
  ON watchdog_revivals (workspace_id, current_session_id);
