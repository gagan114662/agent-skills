-- Real-world tool surface (#231, ADR-0231): the receipts that prove the fleet did REAL work — a live
-- published URL, a parked outward send, or a blocked action telling the owner what to connect. Numbered
-- 0231 by ISSUE (per ADR-0099, to dodge sibling-workspace collisions in the shared migration sequence).
-- Tenant boundary: workspace_id (#3, ON DELETE CASCADE).
--
-- ONE table. venture_id / approval_request_id are SOFT references (the venture/approval may be pruned
-- independently and the receipt must outlive them); only workspace_id carries the FK + tenant boundary.
-- The name is intentionally NOT venture_/growth_-prefixed so the #155 colocation gate does not class it
-- as a governed metric surface.

CREATE TABLE IF NOT EXISTS realworld_artifacts (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  venture_id uuid,                                 -- NULL = workspace-level artifact (soft ref to #96)
  tool text NOT NULL,                              -- publish | send_email | post_social | browse | research | store_asset | call_api
  url text,                                        -- the live reachable URL when status = published
  provider text NOT NULL,                          -- dryrun | github_pages | ...
  status text NOT NULL,                            -- blocked | pending_approval | published | failed
  approval_request_id uuid,                        -- soft ref to the #13 approval that gated it
  detail text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT realworld_artifacts_tool_ck
    CHECK (tool IN ('publish','send_email','post_social','browse','research','store_asset','call_api')),
  CONSTRAINT realworld_artifacts_status_ck
    CHECK (status IN ('blocked','pending_approval','published','failed'))
);

CREATE INDEX IF NOT EXISTS realworld_artifacts_workspace_created_idx
  ON realworld_artifacts (workspace_id, created_at);
