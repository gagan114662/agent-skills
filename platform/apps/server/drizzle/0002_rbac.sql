-- 0002_rbac — role-based permissions (read/write/propagate) + agent deactivation. Issue #9, ADR-0005.
-- Layers roles onto the #4 channel-membership model (ADR-0004 §2): the `permissions` stub
-- from #2 (0000_init) becomes the live capability store.

-- Audit + idempotency for grants. Grants always carry a non-null resource_id (a channel id),
-- so the UNIQUE below gives one effective capability level per (member, resource) and lets
-- grant be an upsert.
ALTER TABLE permissions ADD COLUMN granted_by_member_id uuid REFERENCES members(id) ON DELETE SET NULL;
ALTER TABLE permissions ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE permissions
  ADD CONSTRAINT permissions_member_resource_uniq UNIQUE (workspace_id, member_id, resource_type, resource_id);
CREATE INDEX permissions_member_idx ON permissions (member_id);

-- Deactivation: a non-null timestamp blocks the agent from authenticating (checked in resolveIdentity).
ALTER TABLE agents ADD COLUMN deactivated_at timestamptz;
