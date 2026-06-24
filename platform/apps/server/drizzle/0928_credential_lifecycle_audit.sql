-- 0928_credential_lifecycle_audit — append-only external credential lifecycle audit (#928).
-- Stores no secret values: only service key, actor, action, non-secret fingerprint/env keys/scopes, and time.
CREATE TABLE IF NOT EXISTS external_credential_audit_events (
  id              uuid PRIMARY KEY,
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  service_key     text NOT NULL,
  action          text NOT NULL,
  actor_member_id uuid REFERENCES members(id) ON DELETE SET NULL,
  fingerprint     text,
  env_keys        jsonb NOT NULL DEFAULT '[]'::jsonb,
  scopes          jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT external_credential_audit_events_action_ck CHECK (action IN ('connected','revoked'))
);

CREATE INDEX IF NOT EXISTS external_credential_audit_events_workspace_idx
  ON external_credential_audit_events(workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS external_credential_audit_events_service_idx
  ON external_credential_audit_events(service_key, created_at DESC);
