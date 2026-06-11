-- 0126_agent_credentials — per-tenant Claude subscription credentials vault (issue #68, ADR-0068).
-- One additive, workspace-scoped table so a workspace's fleet agents run on the OWNER's own Claude
-- subscription (CLAUDE_CODE_OAUTH_TOKEN), never a pooled platform key. number-by-issue spacing to
-- dodge sibling-branch migration-number collisions.
--
-- COMPLIANCE: workspace_id is the PRIMARY KEY — exactly one row per tenant — which is what makes
-- pooling one subscription across workspaces structurally impossible. The token is stored SEALED
-- (AES-256-GCM via crypto/secretbox when AGENT_CREDENTIALS_ENC_KEY is set) and is never returned by
-- any API; only the non-reversible fingerprint is surfaced (the UI's "connected" state).
CREATE TABLE workspace_agent_credentials (
  workspace_id           uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  claude_oauth_token     text NOT NULL,                                  -- sealed; never read out by an API
  token_fingerprint      text NOT NULL,                                  -- non-reversible; UI connected state
  connected_by_member_id uuid REFERENCES members(id) ON DELETE SET NULL, -- audit
  connected_at           timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
