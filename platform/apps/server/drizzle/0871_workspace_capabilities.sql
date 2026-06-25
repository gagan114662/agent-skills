CREATE TABLE IF NOT EXISTS workspace_capabilities (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  capability text NOT NULL,
  enabled boolean NOT NULL,
  updated_by_member_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, capability),
  CONSTRAINT workspace_capabilities_capability_ck
    CHECK (capability IN ('marketing', 'onboarding', 'realworld'))
);

CREATE INDEX IF NOT EXISTS workspace_capabilities_workspace_idx
  ON workspace_capabilities (workspace_id, updated_at);
