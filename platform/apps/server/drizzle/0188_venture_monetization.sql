-- Venture monetization rails (#188, ADR-0188): every venture can charge money, the owner holds the keys.
-- Numbered 0188 by ISSUE (per ADR-0099, to dodge sibling-workspace collisions in the shared migration
-- sequence). Tenant boundary: workspace_id (#3, ON DELETE CASCADE).
--
-- THREE tables, named with the NON-governed `monetization_` prefix on purpose: they FK venture_ideas
-- (fine), but a `venture_*`-named table would trip the #155 colocation gate (#194 used `finance_*` for the
-- same reason). Secrets never land here; the per-venture Stripe key lives in the #192 write-only vault.
--
-- The premortem (#200): a plan is a reversible DRAFT until the owner approves its activation through the
-- #13 money queue (FM#4); monetization_revenue holds ONLY signature-verified provider receipts (FM#2).

-- A pricing plan for a venture (product + price). Created `draft` (no Stripe object, no money); mints a
-- REAL hosted payment link only on owner-approved activation (status → active, provider_*/url filled).
CREATE TABLE IF NOT EXISTS monetization_plans (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  venture_idea_id uuid REFERENCES venture_ideas(id) ON DELETE SET NULL,  -- the venture this charges for
  name text NOT NULL,
  amount_cents integer NOT NULL,
  currency text NOT NULL DEFAULT 'usd',
  interval text,                                  -- day|week|month|year | null (one-time)
  status text NOT NULL DEFAULT 'draft',           -- draft|pending_activation|active|archived
  provider text,                                  -- none|stripe (set on activation)
  product_id text,
  price_id text,
  provider_link_id text,
  url text,
  activation_request_id uuid,                     -- soft link to the #13 MONEY decision (audit)
  previous_amount_cents integer,                  -- the price this replaced, when this is a re-price
  created_by_member_id uuid REFERENCES members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  CONSTRAINT monetization_plans_status_ck
    CHECK (status IN ('draft','pending_activation','active','archived')),
  CONSTRAINT monetization_plans_amount_ck CHECK (amount_cents > 0)
);
CREATE INDEX IF NOT EXISTS monetization_plans_workspace_idx ON monetization_plans (workspace_id);
CREATE INDEX IF NOT EXISTS monetization_plans_venture_idx
  ON monetization_plans (workspace_id, venture_idea_id);

-- A pricing experiment a lens/bid proposes. projected_delta_cents is the UNVERIFIED forecast at proposal;
-- verified_revenue_cents/realized_delta_cents are filled from a real Stripe receipt once concluded.
CREATE TABLE IF NOT EXISTS monetization_experiments (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  venture_idea_id uuid REFERENCES venture_ideas(id) ON DELETE SET NULL,
  plan_id uuid REFERENCES monetization_plans(id) ON DELETE SET NULL,
  hypothesis text NOT NULL,
  baseline_amount_cents integer NOT NULL,
  candidate_amount_cents integer NOT NULL,
  baseline_revenue_cents integer NOT NULL DEFAULT 0,  -- projected baseline revenue (price × conversions)
  projected_delta_cents integer NOT NULL DEFAULT 0,   -- UNVERIFIED forecast, not a result
  status text NOT NULL DEFAULT 'proposed',           -- proposed|active|concluded|abandoned
  activation_request_id uuid,                         -- soft link to the #13 MONEY decision (audit)
  verified_revenue_cents integer,                     -- externally-verified outcome (NULL until concluded)
  realized_delta_cents integer,                       -- verified − baseline (NULL until concluded)
  created_by_member_id uuid REFERENCES members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  concluded_at timestamptz,
  CONSTRAINT monetization_experiments_status_ck
    CHECK (status IN ('proposed','active','concluded','abandoned'))
);
CREATE INDEX IF NOT EXISTS monetization_experiments_workspace_idx
  ON monetization_experiments (workspace_id);
CREATE INDEX IF NOT EXISTS monetization_experiments_venture_idx
  ON monetization_experiments (workspace_id, venture_idea_id);

-- A per-venture revenue receipt. Written ONLY by per-venture webhook ingestion after the delivery's
-- signature is verified with that venture's own webhook secret. Deduped on (workspace, provider event id)
-- like revenue_events, so a replayed webhook is a no-op. The #194 ledger reads these as verified credits.
CREATE TABLE IF NOT EXISTS monetization_revenue (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  venture_idea_id uuid REFERENCES venture_ideas(id) ON DELETE SET NULL,  -- the venture this revenue belongs to
  provider text NOT NULL,                          -- stripe
  provider_event_id text NOT NULL,
  type text NOT NULL,                              -- e.g. checkout.session.completed
  amount_cents integer NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'usd',
  status text NOT NULL,                            -- succeeded | paid | ...
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,          -- REDACTED webhook body
  occurred_at timestamptz NOT NULL DEFAULT now(),  -- when the payment happened (period bucket)
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT monetization_revenue_amount_ck CHECK (amount_cents >= 0),
  -- Webhook idempotency: one row per (workspace, provider event id). A replay upserts nothing new.
  CONSTRAINT monetization_revenue_event_uq UNIQUE (workspace_id, provider_event_id)
);
CREATE INDEX IF NOT EXISTS monetization_revenue_workspace_idx
  ON monetization_revenue (workspace_id, occurred_at);
CREATE INDEX IF NOT EXISTS monetization_revenue_venture_idx
  ON monetization_revenue (workspace_id, venture_idea_id);
