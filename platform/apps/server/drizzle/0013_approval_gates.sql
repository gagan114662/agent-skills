-- 0013_approval_gates — human approval gates & governance for sensitive actions. Issue #13, ADR-0013.
-- Additive on top of #3 (members), #4 (channels), #8 (notifications), #9 (RBAC), #25 (agent sessions).
-- Two new tables; no existing table is touched. Numbered 0013 to match the issue (0025_agent_sessions
-- is a sibling branch's reserved number; the runner applies pending files by name, deps are 0000–0004).

-- The audit record for one requested sensitive action. Created at request time; advanced to a terminal
-- status by a human decision (or auto-approved when the policy does not gate it). workspace_id + the
-- reference columns are denormalized so the audit list is a single-table, workspace-scoped read.
-- `action` is the opaque descriptor (amount/destination/etc.); `action_summary` is the human preview.
-- A terminal row is immutable (the service only ever updates a row WHERE status = 'pending').
CREATE TABLE approval_requests (
  id                       uuid PRIMARY KEY,
  workspace_id             uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  requested_by_member_id   uuid NOT NULL REFERENCES members(id)    ON DELETE CASCADE,
  action_kind              text NOT NULL,
  action_summary           text NOT NULL,
  action                   jsonb NOT NULL DEFAULT '{}'::jsonb,
  channel_id               uuid REFERENCES channels(id) ON DELETE SET NULL,
  status                   text NOT NULL DEFAULT 'pending',
  policy_reason            text,
  decided_by_member_id     uuid REFERENCES members(id) ON DELETE SET NULL,
  decision_reason          text,
  outcome                  text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  decided_at               timestamptz,
  executed_at              timestamptz,
  expires_at               timestamptz,
  CONSTRAINT approval_requests_status_ck
    CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'auto_approved')),
  CONSTRAINT approval_requests_kind_ck
    CHECK (action_kind IN ('external_send', 'spend', 'channel_post', 'custom'))
);
-- audit query: a workspace's requests by status, newest first
CREATE INDEX approval_requests_workspace_idx ON approval_requests (workspace_id, status, created_at);
-- "what has this member requested?"
CREATE INDEX approval_requests_requester_idx ON approval_requests (requested_by_member_id);

-- Per-workspace governance policy (the four levers + a TTL). One row per workspace; defaults are
-- applied in code when no row exists (so an unconfigured workspace still gates external sends + spend).
CREATE TABLE governance_policies (
  workspace_id                     uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  spend_threshold_cents            integer NOT NULL DEFAULT 0,
  external_send_requires_approval  boolean NOT NULL DEFAULT true,
  require_approval_for             jsonb NOT NULL DEFAULT '[]'::jsonb,
  guarded_channel_ids              jsonb NOT NULL DEFAULT '[]'::jsonb,
  default_ttl_ms                   bigint NOT NULL DEFAULT 86400000,
  updated_at                       timestamptz NOT NULL DEFAULT now()
);
