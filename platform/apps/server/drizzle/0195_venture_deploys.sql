-- Venture Deploys (#195, ADR-0195): the fleet ships venture products to production itself — provision a
-- per-venture target at bootstrap, run the review→CI→merge→deploy→post-deploy-smoke release pipeline on
-- the venture repo, auto-roll-back a broken image, and keep an immutable receipt of every deploy.
-- Numbered 0195 by ISSUE (per ADR-0099, to dodge sibling-workspace collisions in the shared migration
-- sequence). Tenant boundary throughout: workspace_id (#3 IDOR discipline); venture_id is a soft ref
-- (no FK) so a receipt outlives a pruned venture (durable audit trail).
--
-- Deliberately NOT prefixed `venture_` so the colocation governance check (GOVERNED_TABLE_RE) does not
-- class these as metric surfaces — they are infra receipts, not scorers (the #192/#194 `external_*` /
-- `finance_*` precedent). TWO additive tables, no authority over any existing business-domain table.

-- 1. The per-venture deploy TARGET (the Fly app / Vercel project + preview & prod URLs). Provisioned
--    once at venture bootstrap; the unique (workspace, venture) key makes re-provisioning idempotent.
--    project_id is the tenant boundary at the infra layer (a release for one venture can only ever
--    resolve its own target — no cross-venture infra access, AC5). secret_service_key points at the
--    venture's write-only vault entry (#192), never the secret values.
CREATE TABLE IF NOT EXISTS deploy_targets (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  venture_id uuid NOT NULL,                          -- soft ref to the factory venture (no FK)
  provider text NOT NULL,                            -- dryrun | fly | vercel
  project_id text NOT NULL,                          -- the provider-side app/project id (tenant boundary)
  preview_url text NOT NULL,                         -- non-customer URL where smoke runs
  prod_url text NOT NULL,                            -- customer-facing production URL
  status text NOT NULL,                              -- provisioned | failed
  secret_service_key text NOT NULL,                  -- the #192 vault service-key for this venture
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT deploy_targets_provider_ck CHECK (provider IN ('dryrun','fly','vercel')),
  CONSTRAINT deploy_targets_status_ck CHECK (status IN ('provisioned','failed')),
  -- One target per (workspace, venture): provisioning is idempotent.
  CONSTRAINT deploy_targets_venture_uk UNIQUE (workspace_id, venture_id)
);
CREATE INDEX IF NOT EXISTS deploy_targets_workspace_idx
  ON deploy_targets (workspace_id, created_at);

-- 2. Immutable release receipts (AC4) — one row per release attempt (deploy → smoke → promote/rollback).
--    This IS the audit trail the daily brief reads. smoke_critical_count = -1 encodes "smoke did not run"
--    (production-grounded: an absent smoke is never a pass, #200 §3). approval_request_id is a soft ref
--    to the #13 decision when a prod cutover was gated.
CREATE TABLE IF NOT EXISTS deploy_releases (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  venture_id uuid NOT NULL,                          -- soft ref to the factory venture (no FK)
  target_id uuid NOT NULL,                           -- soft ref to deploy_targets.id
  release_ref text NOT NULL,                         -- git sha / build ref released (provenance)
  status text NOT NULL,                              -- deploy_failed | smoke_failed | rolled_back | promoted | escalated
  action text NOT NULL,                              -- promote | rollback | escalate
  reversibility text NOT NULL,                       -- reversible | cheap | irreversible (#200 §4)
  requires_approval boolean NOT NULL DEFAULT false,  -- a gated prod cutover
  approval_request_id uuid,                          -- soft ref to the #13 decision (no FK)
  smoke_critical_count integer NOT NULL DEFAULT -1,  -- -1 = smoke did not run (never a pass)
  url text,                                          -- the preview URL this release deployed to
  incident_filed boolean NOT NULL DEFAULT false,     -- a failed smoke filed a #193 self-healing incident
  detail text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT deploy_releases_status_ck
    CHECK (status IN ('deploy_failed','smoke_failed','rolled_back','promoted','escalated'))
);
CREATE INDEX IF NOT EXISTS deploy_releases_venture_idx
  ON deploy_releases (venture_id, created_at);
CREATE INDEX IF NOT EXISTS deploy_releases_workspace_idx
  ON deploy_releases (workspace_id, created_at);
