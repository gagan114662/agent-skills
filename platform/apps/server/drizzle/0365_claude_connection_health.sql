-- #365: connection-health signal for the per-tenant Connect-Claude vault.
-- The owner needs to see "connected / not connected / token expired" at a glance so the seeded fleet
-- actually RUNS on the subscription token (#246) instead of every agent returning "reconnect your Claude".
-- This adds an OBSERVED auth-failure marker: when a workspace HAS a connected credential row yet a real
-- agent launch resolves no usable auth (a removed/blanked/broken stored token), the marker is stamped and
-- auth/claude-connect-health.ts derives the `expired` state. Reconnecting (last write wins) clears it.
-- Additive + nullable: NULL ⇒ "no failure observed", so existing rows degrade to plain `connected`. Never
-- holds a token or secret (#365 hard boundary) — only a timestamp.
ALTER TABLE workspace_agent_credentials ADD COLUMN IF NOT EXISTS last_auth_failure_at timestamptz;
