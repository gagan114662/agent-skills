-- Workspace catalog + visual workflow builder (#152, ADR-0152). Generalizes the #147 automations
-- (trigger → run) into trigger → condition → action chains, and adds a structured registry of the
-- workspace's marketing assets that agents read for context. Three workspace-scoped tables; every read
-- carries the #3 tenant boundary. No table here weakens an existing gate: a workflow's agent action
-- launches through the SAME #123 venture-gated, draft-only path automations use, and a draft_send
-- action becomes a #13 pending approval — never a direct egress.

-- (1) The workspace catalog: a structured row per marketing asset (site, brand kit, social account,
-- email domain, ad account, analytics property, venture, deployed app, …) with ownership, status, and
-- provenance. Agents read it for context instead of asking the owner repeatedly. `identifier` is the
-- canonical handle/URL; `metadata` holds kind-specific extras. Tenant-scoped via workspace_id.
CREATE TABLE IF NOT EXISTS catalog_entries (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind text NOT NULL,
  name text NOT NULL,
  identifier text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active',
  provenance text NOT NULL DEFAULT 'manual',
  owner_member_id uuid REFERENCES members(id) ON DELETE SET NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_member_id uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT catalog_entries_kind_ck CHECK (kind IN (
    'site','brand_kit','social_account','email_domain','ad_account',
    'analytics_property','venture','deployed_app','repo','other'
  )),
  CONSTRAINT catalog_entries_status_ck CHECK (status IN ('active','inactive','pending','archived')),
  CONSTRAINT catalog_entries_provenance_ck CHECK (provenance IN ('manual','synced','agent'))
);
CREATE INDEX IF NOT EXISTS catalog_entries_workspace_idx ON catalog_entries (workspace_id);
CREATE INDEX IF NOT EXISTS catalog_entries_workspace_kind_idx ON catalog_entries (workspace_id, kind);

-- (2) A workflow definition: trigger → conditions → actions, stored as data so a pure evaluator decides
-- firings and the engine reuses existing task/approval paths. enabled defaults false (creating one never
-- fires until opted in). `trigger` jsonb carries the kind + its config (schedule cadence / catalog kind /
-- channel id); `conditions` is an AND-list of pure predicates over a facts bag; `actions` is the ordered
-- action list. webhook_token_hash holds the sha-256 of the one-shown token for a webhook trigger;
-- next_run_at is the scheduler cursor for a schedule trigger (enabled AND next_run_at <= now = due).
CREATE TABLE IF NOT EXISTS workflows (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  trigger_kind text NOT NULL,
  trigger jsonb NOT NULL DEFAULT '{}'::jsonb,
  conditions jsonb NOT NULL DEFAULT '[]'::jsonb,
  actions jsonb NOT NULL DEFAULT '[]'::jsonb,
  webhook_token_hash text,
  enabled boolean NOT NULL DEFAULT false,
  created_by_member_id uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  last_fired_at timestamptz,
  next_run_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflows_trigger_kind_ck CHECK (trigger_kind IN ('schedule','webhook','catalog_change','channel_event'))
);
CREATE INDEX IF NOT EXISTS workflows_workspace_idx ON workflows (workspace_id);
CREATE INDEX IF NOT EXISTS workflows_due_idx ON workflows (enabled, next_run_at);

-- (3) The durable run ledger: every workflow firing (fired/skipped/blocked/failed). `results` records the
-- per-action outcome bundle (no secrets — the engine records only action kinds, statuses, and reference
-- ids). Feeds the console's success/failure trends and the #117 flywheel (a failed run fingerprints like
-- any other failure). The cascade rides workspace_id / workflow_id.
CREATE TABLE IF NOT EXISTS workflow_runs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workflow_id uuid NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  trigger text NOT NULL,
  status text NOT NULL,
  reason text NOT NULL DEFAULT '',
  results jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflow_runs_trigger_ck CHECK (trigger IN ('schedule','webhook','catalog_change','channel_event','manual')),
  CONSTRAINT workflow_runs_status_ck CHECK (status IN ('fired','skipped','blocked','failed'))
);
CREATE INDEX IF NOT EXISTS workflow_runs_workspace_created_idx ON workflow_runs (workspace_id, created_at);
CREATE INDEX IF NOT EXISTS workflow_runs_workflow_idx ON workflow_runs (workflow_id);
