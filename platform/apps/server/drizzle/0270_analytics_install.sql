-- Analytics auto-install (#270, ADR-0270). One workspace-scoped table.
-- Numbered 0270 by ISSUE (per ADR-0099, to dodge sibling-workspace collisions in the shared sequence).
-- Tenant boundary: workspace_id (#3, ON DELETE CASCADE). The name is deliberately NOT growth_/venture_/
-- moat_/demand_-prefixed so the #155 colocation gate does not class it as a governed metric surface.
--
-- analytics_installs — the durable proof that ipop put the analytics tag on a workspace's site WITHOUT
-- the owner writing a line of code (the "no tag or code work by the user" promise of #270). One row per
-- workspace (the unique index on workspace_id makes install idempotent — re-installing updates the row).
-- It holds NO credential and NO metric: read numbers come live from the provider; the vendor key lives in
-- the #192 / #267 vault. `snippet_fingerprint` drives idempotent re-install when the provider/id change.

CREATE TABLE IF NOT EXISTS analytics_installs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  method text NOT NULL,                              -- hosted_auto_inject | connector_inject | manual_pending
  provider text NOT NULL,                            -- dryrun | ga4 | plausible
  measurement_id text NOT NULL DEFAULT '',           -- GA4 measurement id / Plausible domain (empty until set)
  snippet_fingerprint text NOT NULL,                 -- content fingerprint of the installed snippet
  installed_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT analytics_installs_method_ck
    CHECK (method IN ('hosted_auto_inject','connector_inject','manual_pending'))
);

CREATE UNIQUE INDEX IF NOT EXISTS analytics_installs_workspace_unique ON analytics_installs (workspace_id);
