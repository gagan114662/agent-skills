-- Finance Ledger (#194, ADR-0194): books that close themselves, money decisions in one queue.
-- Numbered 0194 by ISSUE (per ADR-0099, to dodge sibling-workspace collisions in the shared migration
-- sequence). Tenant boundary: workspace_id (#3, ON DELETE CASCADE).
--
-- TWO tables — the continuous per-venture ledger + the closed monthly books. Like #173 founder_briefings,
-- this is the finance layer's OWN bookkeeping about money already received/spent (sourced from external
-- receipts), NOT authority over billing: nothing here moves money. Every entry carries verified + source
-- + source_ref (the external receipt it dedupes on), so estimate-derived numbers are labeled UNVERIFIED.

-- The continuous double-entry-ish ledger. direction carries the sign; amount_cents is always >= 0.
-- Idempotency = unique(workspace_id, source, source_ref): re-posting the same receipt (the engine runs
-- every tick) is a no-op/upsert, never a double-count (mirrors revenue_events' provider_event_id dedupe).
CREATE TABLE IF NOT EXISTS finance_ledger_entries (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  venture_idea_id uuid REFERENCES venture_ideas(id) ON DELETE SET NULL,  -- NULL = workspace-level entry
  direction text NOT NULL,                       -- 'credit' (revenue inflow) | 'debit' (cost outflow)
  category text NOT NULL,                         -- 'revenue.stripe' | 'cost.model' | 'cost.infra' | ...
  amount_cents integer NOT NULL,                  -- always >= 0; the sign is the direction
  currency text NOT NULL DEFAULT 'usd',
  verified boolean NOT NULL,                       -- TRUE only when backed by an external receipt
  source text NOT NULL,                            -- 'stripe_event' | 'tenant_usage' | 'manual'
  source_ref text NOT NULL,                        -- the external receipt id (dedupe key)
  occurred_at timestamptz NOT NULL,                -- when the economic event happened (period bucket)
  memo text,
  created_by_member_id uuid REFERENCES members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT finance_ledger_direction_ck CHECK (direction IN ('credit','debit')),
  CONSTRAINT finance_ledger_source_ck CHECK (source IN ('stripe_event','tenant_usage','manual')),
  CONSTRAINT finance_ledger_amount_ck CHECK (amount_cents >= 0),
  -- Idempotency watermark: one entry per external receipt. A repeat tick upserts, never duplicates.
  CONSTRAINT finance_ledger_source_uk UNIQUE (workspace_id, source, source_ref)
);
CREATE INDEX IF NOT EXISTS finance_ledger_workspace_idx
  ON finance_ledger_entries (workspace_id, occurred_at);
CREATE INDEX IF NOT EXISTS finance_ledger_venture_idx
  ON finance_ledger_entries (workspace_id, venture_idea_id);

-- The closed monthly book per venture-scope + period. venture_idea_id NULL = the workspace-level book.
CREATE TABLE IF NOT EXISTS finance_close_packs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  venture_idea_id uuid REFERENCES venture_ideas(id) ON DELETE SET NULL,  -- NULL = workspace-level book
  period_key text NOT NULL,                        -- 'YYYY-MM'
  currency text NOT NULL DEFAULT 'usd',
  revenue_cents integer NOT NULL DEFAULT 0,
  cost_cents integer NOT NULL DEFAULT 0,
  verified_revenue_cents integer NOT NULL DEFAULT 0,  -- externally-verified subset of revenue
  verified_cost_cents integer NOT NULL DEFAULT 0,     -- externally-verified subset of cost
  net_cents integer NOT NULL DEFAULT 0,            -- revenue_cents - cost_cents, signed
  verified_share_bps integer NOT NULL DEFAULT 0,   -- 0..10000: external-receipt share of the period (#200)
  entry_count integer NOT NULL DEFAULT 0,
  unit_economics jsonb NOT NULL DEFAULT '{}'::jsonb,  -- {cacCents,ltvCents,marginBps,ltvToCacX100}
  closed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT finance_close_packs_revenue_ck CHECK (revenue_cents >= 0),
  CONSTRAINT finance_close_packs_cost_ck CHECK (cost_cents >= 0),
  CONSTRAINT finance_close_packs_share_ck CHECK (verified_share_bps >= 0 AND verified_share_bps <= 10000)
);
CREATE INDEX IF NOT EXISTS finance_close_packs_workspace_idx
  ON finance_close_packs (workspace_id, period_key);
-- One book per (workspace, venture-scope, period). COALESCE folds the workspace-level book (NULL venture)
-- into a single uniqueable key, since a plain UNIQUE treats NULLs as distinct (would allow duplicates).
CREATE UNIQUE INDEX IF NOT EXISTS finance_close_packs_scope_uk
  ON finance_close_packs (workspace_id, period_key, COALESCE(venture_idea_id, '00000000-0000-0000-0000-000000000000'::uuid));
