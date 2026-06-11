-- Portfolio Lifecycle Loop (#107, ADR-0107): durable ledger of per-launched-venture reviews.
-- One workspace-scoped, append-only table. Each row snapshots the KPI evidence a review decided on
-- (growth #102 / moat #103 / demand #101 / revenue #98 / infra burn #71), the decision, the reasons,
-- and — for a SUNSET — the #13 approval link + lifecycle status. The portfolio dashboard + Founder
-- Console (#104) are projections of these rows. workspace_id carries the #3 tenant boundary (cascade);
-- venture_idea_id cascades so a venture's reviews die with it; approval_request_id SET NULL so a pruned
-- approval doesn't orphan a row. decision + status are CHECK-constrained.
CREATE TABLE IF NOT EXISTS portfolio_reviews (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  venture_idea_id uuid NOT NULL REFERENCES venture_ideas(id) ON DELETE CASCADE,
  decision text NOT NULL,
  score integer NOT NULL,
  growth_score integer NOT NULL,
  moat_score integer NOT NULL,
  moat_stagnant boolean NOT NULL,
  demand_signals integer NOT NULL,
  revenue_cents integer NOT NULL,
  monthly_cost_cents integer NOT NULL,
  net_cents integer NOT NULL,
  age_in_days integer NOT NULL,
  reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'recorded',
  approval_request_id uuid REFERENCES approval_requests(id) ON DELETE SET NULL,
  created_by_member_id uuid REFERENCES members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT portfolio_reviews_decision_ck
    CHECK (decision IN ('DOUBLE_DOWN','MAINTAIN','PIVOT','SUNSET')),
  CONSTRAINT portfolio_reviews_status_ck
    CHECK (status IN ('recorded','sunset_pending','sunset_executed','sunset_rejected'))
);
CREATE INDEX IF NOT EXISTS portfolio_reviews_workspace_venture_idx
  ON portfolio_reviews (workspace_id, venture_idea_id);
CREATE INDEX IF NOT EXISTS portfolio_reviews_workspace_decision_idx
  ON portfolio_reviews (workspace_id, decision);
CREATE INDEX IF NOT EXISTS portfolio_reviews_workspace_created_idx
  ON portfolio_reviews (workspace_id, created_at);
