-- Central provisioning usage ledger (#267, ADR-0267). One workspace-scoped table records each use of a
-- centrally-held paid API (keyword/SERP data, social posting, ads management) so ipop bills the cost of
-- goods into the plan. Numbered 0267 by ISSUE (per ADR-0099, to dodge sibling-workspace collisions in the
-- shared sequence). Tenant boundary: workspace_id (#3, ON DELETE CASCADE). The name is deliberately NOT
-- venture_/growth_/demand_/moat_-prefixed so the #155 colocation gate does not class it a governed metric
-- surface. Holds NO secret — only the structural provider id, units, cost of goods, and an OPTIONAL
-- external receipt. Premortem #200 §2: `verified` is true only when `external_ref` is present.

CREATE TABLE IF NOT EXISTS provisioning_usage (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  capability_id text NOT NULL,                     -- catalog id: keyword_data | serp_data | social_post | ...
  provider text NOT NULL,                          -- structural provider id that served the call (never a key)
  units integer NOT NULL DEFAULT 0,                -- billable units consumed
  cost_cents integer NOT NULL DEFAULT 0,           -- cost of goods ipop incurred (billed into the plan)
  external_ref text,                               -- provider receipt/request id (NULL ⇒ UNVERIFIED estimate)
  verified boolean NOT NULL DEFAULT false,         -- derived from external_ref presence at write time (§2)
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS provisioning_usage_workspace_idx ON provisioning_usage (workspace_id, occurred_at);
CREATE INDEX IF NOT EXISTS provisioning_usage_capability_idx ON provisioning_usage (workspace_id, capability_id);
