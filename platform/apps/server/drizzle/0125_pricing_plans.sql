-- 0125_pricing_plans — pricing page + Stripe checkout (issue #125, ADR-0125).
-- Two additive, workspace-scoped tables on top of the merged #98 revenue rails. No secret lands here
-- (the #98 invariant). number-by-issue (0125) to dodge sibling-branch migration-number collisions.

-- The active plan for a workspace (one row per workspace, upserted on activation). The caps columns are
-- the observable "caps updated" state, written from the pure plan catalog when the merged, deduped
-- webhook reports a plan_checkout payment. INBOUND only — activation never moves money.
CREATE TABLE workspace_plans (
  workspace_id                  uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  plan_key                      text NOT NULL,                       -- starter | pro | agency
  status                        text NOT NULL DEFAULT 'active',      -- active | canceled
  agent_seats                   integer NOT NULL,
  monthly_session_budget_cents  integer NOT NULL,
  fleet_size                    integer NOT NULL,
  provider_event_id             text,                                -- the webhook event that activated it
  activated_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now()
);

-- The idempotent product/price registry. The composite PK makes "create products/prices idempotently"
-- a one-line ON CONFLICT DO NOTHING — bootstrap (or a concurrent checkout) creates no duplicate Stripe
-- product. Ids only — no secret, no amount.
CREATE TABLE billing_plan_prices (
  workspace_id   uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  plan_key       text NOT NULL,                                      -- starter | pro | agency
  provider       text NOT NULL,                                      -- none | stripe
  product_id     text NOT NULL,
  price_id       text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, plan_key, provider)
);
