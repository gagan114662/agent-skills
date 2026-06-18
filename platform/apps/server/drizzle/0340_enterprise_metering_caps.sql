-- Enterprise layer: per-agent + per-customer usage metering + hard budget caps (#340, ADR-0340). Two
-- workspace-scoped tables back the governance + cost-control layer that lets ipop sell the fleet. Numbered
-- 0340 by ISSUE (per ADR-0099, to dodge sibling-workspace collisions in the shared sequence). Tenant
-- boundary: workspace_id (#3, ON DELETE CASCADE). The names are deliberately NOT tenant_usage*/venture_/
-- growth_/demand_/moat_-prefixed so the #155 colocation gate does not class them as governed metric surfaces
-- (operational metering, like provisioning_usage). Holds NO secret. Premortem #200 §2: a usage row is
-- `verified` only when `external_ref` is present.

CREATE TABLE IF NOT EXISTS enterprise_usage (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id text NOT NULL,                          -- the department agent / persona (the per-agent dimension)
  kind text NOT NULL,                              -- model | tool | action
  resource text NOT NULL,                          -- model id / tool name / action type (sanitized; never a key)
  provider text,                                   -- provider that emitted the receipt (sanitized; NULL ⇒ estimate)
  units integer NOT NULL DEFAULT 0,                -- billable units consumed
  cost_cents integer NOT NULL DEFAULT 0,           -- cost of goods incurred
  external_ref text,                               -- provider receipt/request id (NULL ⇒ UNVERIFIED estimate)
  verified boolean NOT NULL DEFAULT false,         -- derived from external_ref presence at write time (§2)
  receipt_id text NOT NULL,                         -- deterministic provenance handle (content hash)
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS enterprise_usage_workspace_idx ON enterprise_usage (workspace_id, occurred_at);
CREATE INDEX IF NOT EXISTS enterprise_usage_agent_idx ON enterprise_usage (workspace_id, agent_id);

-- Pre-committed per-customer (scope='customer', subject = workspace id) and per-agent (scope='agent',
-- subject = agent id) hard spend ceilings the system never crosses, plus the committed-so-far counter.
CREATE TABLE IF NOT EXISTS enterprise_budget_caps (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  scope text NOT NULL,                              -- customer | agent
  subject_id text NOT NULL,                         -- workspace id (customer) or agent id (agent)
  cap_cents integer NOT NULL DEFAULT 0,            -- hard ceiling the committed total may never exceed
  committed_cents integer NOT NULL DEFAULT 0,      -- cents committed against the cap so far
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT enterprise_budget_caps_subject_unique UNIQUE (workspace_id, scope, subject_id)
);
