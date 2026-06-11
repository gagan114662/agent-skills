-- 0151_ona_governance_trust — Ona-class governance & trust (issue #151, ADR-0151).
-- Three additive, workspace-scoped tables. No existing table is touched, so a deployment that never
-- enables RBAC or the egress allowlist keeps today's behavior exactly. number-by-issue spacing (0151)
-- to dodge sibling-branch migration-number collisions.
--
-- COMPLIANCE: roles/invites carry NO secrets; the credential allowlist matrix lives in #58 config (key
-- NAMES only). egress_violations is append-only (the durable flagged-domains report) and mirrors
-- approval_events — written in the same path as the decision, never updated or deleted, so the audit
-- can never drift from what happened.

-- Workspace-level role grants: owner > approver > viewer. One row per (workspace, member).
CREATE TABLE workspace_member_roles (
  id                    uuid PRIMARY KEY,
  workspace_id          uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  member_id             uuid NOT NULL REFERENCES members(id)    ON DELETE CASCADE,
  role                  text NOT NULL,
  granted_by_member_id  uuid REFERENCES members(id) ON DELETE SET NULL,  -- audit (soft)
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspace_member_roles_uniq UNIQUE (workspace_id, member_id),
  CONSTRAINT workspace_member_roles_role_ck CHECK (role IN ('viewer','approver','owner'))
);

-- Email invites. The raw token is shown once and never stored — only its sha-256 hash lives here.
CREATE TABLE workspace_invites (
  id                  uuid PRIMARY KEY,
  workspace_id        uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email               text NOT NULL,
  role                text NOT NULL,
  token_hash          text NOT NULL,                                    -- sha-256 of the raw token
  status              text NOT NULL DEFAULT 'pending',
  invited_by_member_id uuid REFERENCES members(id) ON DELETE SET NULL,
  accepted_member_id  uuid REFERENCES members(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  accepted_at         timestamptz,
  CONSTRAINT workspace_invites_ws_email_uniq UNIQUE (workspace_id, email),
  CONSTRAINT workspace_invites_status_ck CHECK (status IN ('pending','accepted','revoked'))
);

-- Append-only egress audit: one row per denied/flagged outbound target (the flagged-domains report).
CREATE TABLE egress_violations (
  id              uuid PRIMARY KEY,
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id      uuid,                                                 -- soft; the violation outlives the session
  actor_member_id uuid REFERENCES members(id) ON DELETE SET NULL,
  target          text NOT NULL,
  domain          text,
  reason          text NOT NULL,
  detail          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX egress_violations_workspace_created_idx ON egress_violations (workspace_id, created_at);
CREATE INDEX egress_violations_domain_idx           ON egress_violations (workspace_id, domain);
