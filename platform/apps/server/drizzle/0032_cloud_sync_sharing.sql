-- 0032_cloud_sync_sharing — persistent & shared cloud workspaces (issue #55, ADR-0032).
-- Builds on #25 cloud execution: a session runs server-side and snapshots its filesystem at
-- teardown. This adds a DURABLE cloud workspace that outlives any one session — it retains the
-- latest snapshot (resume key), can be slept/woken to save resources, mirrors its files to a
-- local directory (setup-on-first-mirror), and can be shared with scoped, revocable collaborators.

-- A durable cloud filesystem environment within a tenant. One tenant (workspaces) has many.
CREATE TABLE cloud_workspaces (
  id                    uuid PRIMARY KEY,
  workspace_id          uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name                  text NOT NULL,
  -- active = usable now; sleeping = idle, snapshot retained for fast wake; archived = cold.
  status                text NOT NULL DEFAULT 'active',
  -- latest filesystem snapshot (from a session teardown / sync) — the wake/resume key. No secrets.
  snapshot_id           text,
  -- setup-on-first-mirror: the one-time setup command has run for this workspace.
  setup_completed       boolean NOT NULL DEFAULT false,
  -- owner; nullable so a member can be removed without dropping the workspace. Owner = admin.
  created_by_member_id  uuid REFERENCES members(id) ON DELETE SET NULL,
  -- drives the idle sweep (sleep workspaces idle longer than CLOUD_IDLE_MS).
  last_active_at        timestamptz NOT NULL DEFAULT now(),
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cloud_workspaces_status_ck CHECK (status IN ('active', 'sleeping', 'archived'))
);

CREATE INDEX cloud_workspaces_workspace_idx ON cloud_workspaces (workspace_id);
-- the idle sweep scans active workspaces by last activity
CREATE INDEX cloud_workspaces_status_idx ON cloud_workspaces (status, last_active_at);

-- Scoped, revocable collaborator access on a cloud workspace (#9 RBAC ladder). The owner holds
-- propagate implicitly (no row). revoked_at IS NULL means the grant is active; setting it cuts
-- access immediately while keeping the audit trail.
CREATE TABLE cloud_workspace_collaborators (
  id                    uuid PRIMARY KEY,
  cloud_workspace_id    uuid NOT NULL REFERENCES cloud_workspaces(id) ON DELETE CASCADE,
  member_id             uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  capability            text NOT NULL,   -- 'read' | 'write' | 'propagate' (#9 ladder)
  granted_by_member_id  uuid REFERENCES members(id) ON DELETE SET NULL,
  granted_at            timestamptz NOT NULL DEFAULT now(),
  revoked_at            timestamptz,
  CONSTRAINT cloud_ws_collab_capability_ck CHECK (capability IN ('read', 'write', 'propagate')),
  -- one row per (workspace, member); re-inviting upserts (and clears revoked_at)
  CONSTRAINT cloud_ws_collab_unique UNIQUE (cloud_workspace_id, member_id)
);

-- "shared with me": list the cloud workspaces a member collaborates on
CREATE INDEX cloud_ws_collab_member_idx ON cloud_workspace_collaborators (member_id);
