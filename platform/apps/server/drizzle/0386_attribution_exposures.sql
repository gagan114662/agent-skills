-- Attributed-revenue ledger (#386, ADR-0386). One additive, workspace-scoped table: the EXPOSURE — a fleet
-- artifact shown to the world under a stable tracking ref (attribution/tracking.ts). It is the head of the
-- causal chain `artifact -> exposure -> signup -> payment`; the signup side already persists as a #101 demand
-- signal keyed on the recovered ref, and the payment side already persists as a #98 `revenue_events` row.
-- Joining the three by tracking ref is the attribution projection (credit by happened-before, L2; every
-- credited dollar backed by an external receipt, L1). Numbered 0386 by ISSUE (per ADR-0099, to dodge
-- sibling-workspace collisions in the shared migration sequence). Tenant boundary: workspace_id (#3, ON
-- DELETE CASCADE). The name is deliberately NOT tenant_usage*/venture_/growth_/demand_/moat_-prefixed so the
-- #155 colocation gate does not class it as a governed metric surface. Holds NO secret and no money.
CREATE TABLE IF NOT EXISTS attribution_exposures (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  artifact_id text NOT NULL,                       -- the fleet artifact a future payment is credited to
  artifact_kind text NOT NULL,                     -- seo_page | social_post | email | ad | site_pr | ...
  tracking_ref text NOT NULL,                      -- the stable ref minted for (workspace, artifact, channel)
  channel text NOT NULL,                           -- seo | social | email | ads | ...
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- One exposure row per (workspace, tracking ref): re-stamping the same artifact is idempotent.
  CONSTRAINT attribution_exposures_ref_uq UNIQUE (workspace_id, tracking_ref)
);

CREATE INDEX IF NOT EXISTS attribution_exposures_workspace_idx ON attribution_exposures (workspace_id, occurred_at);
CREATE INDEX IF NOT EXISTS attribution_exposures_artifact_idx ON attribution_exposures (workspace_id, artifact_id);
