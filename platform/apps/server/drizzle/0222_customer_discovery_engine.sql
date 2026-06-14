-- Customer Discovery Engine (#222, ADR-0222): the per-venture signal layer that turns real product-usage
-- + connected-channel receipts into a ranked "who to reach out to now" queue + PQL events, and models the
-- 5-stage GTM pipeline. Numbered 0222 by ISSUE (per ADR-0099, to dodge sibling-workspace collisions in the
-- shared migration sequence). Tenant boundary throughout: workspace_id (#3 IDOR discipline). Table names
-- are deliberately `discovery_*` (not `growth_*`/`venture_*`/`demand_*`) so the #155 metric-surface
-- colocation check is not tripped. READ-ONLY feature (nothing here sends — outreach is #225).
--
-- FOUR additive tables, no authority over any existing business-domain table:
--   1. discovery_signal_defs       — the owner-defined qualifying signals (what makes a prospect "PQL").
--   2. discovery_signals           — the signal store: one REAL product/channel receipt per row.
--   3. discovery_pql_events        — a PQL event fired the moment real signals satisfy a definition.
--   4. discovery_pipeline_entries  — the 5-stage GTM pipeline membership (per-stage prospect entries).

-- 1. The owner-defined qualifying signal (AC1): the owner sets the kind + thresholds; the engine evaluates
--    real signals against it. weight (0–100) is the contribution to the conversion-likelihood score.
CREATE TABLE IF NOT EXISTS discovery_signal_defs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  idea_id uuid,                                    -- soft ref (no FK); null = workspace-level
  kind text NOT NULL,                              -- power_user_threshold | usage_trend | pricing_page_visit | role_match
  label text NOT NULL,
  threshold integer NOT NULL DEFAULT 1,            -- the value/count floor that qualifies
  window_days integer NOT NULL DEFAULT 14,         -- the lookback window
  role text,                                       -- the role/seniority to match (role_match defs)
  weight integer NOT NULL DEFAULT 50,              -- 0–100 contribution to the likelihood score
  enabled boolean NOT NULL DEFAULT true,
  created_by_member_id uuid REFERENCES members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT discovery_signal_defs_kind_ck
    CHECK (kind IN ('power_user_threshold','usage_trend','pricing_page_visit','role_match')),
  CONSTRAINT discovery_signal_defs_weight_ck CHECK (weight >= 0 AND weight <= 100),
  -- One definition per (workspace, idea, label): re-defining upserts rather than stacking.
  CONSTRAINT discovery_signal_defs_label_uk UNIQUE (workspace_id, idea_id, label)
);

-- 2. The signal store (AC1): one REAL product/channel receipt per row — never fabricated. prospect_key is
--    an OPAQUE actor token (no PII — emails rejected at ingest). external_ref is the verification anchor: a
--    non-empty value (e.g. a Stripe event id) is what lets a downstream metric be VERIFIED (premortem #200
--    §2); a likelihood score is otherwise labeled UNVERIFIED.
CREATE TABLE IF NOT EXISTS discovery_signals (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  idea_id uuid,                                    -- soft ref (no FK)
  prospect_key text NOT NULL,                      -- opaque actor token (no PII)
  kind text NOT NULL,                              -- usage_event | pricing_page_visit | role_identified | conversion
  value integer NOT NULL DEFAULT 1,
  role text,                                       -- identified role for a role_identified signal
  source text NOT NULL DEFAULT '',
  external_ref text,                               -- real external reference; null = self-reported
  occurred_at timestamptz NOT NULL DEFAULT now(),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT discovery_signals_kind_ck
    CHECK (kind IN ('usage_event','pricing_page_visit','role_identified','conversion'))
);
CREATE INDEX IF NOT EXISTS discovery_signals_idea_idx ON discovery_signals (workspace_id, idea_id);
CREATE INDEX IF NOT EXISTS discovery_signals_prospect_idx ON discovery_signals (workspace_id, prospect_key);

-- 3. The PQL event (AC1): emitted the moment a prospect's real signals satisfy an owner-defined
--    definition. score is a 0–100 conversion LIKELIHOOD (always UNVERIFIED — a prediction, not a receipt).
--    verified is true ONLY when an externally-attributed conversion grounded the qualification. One row per
--    (workspace, prospect, def): re-qualifying the same prospect on the same definition is idempotent.
CREATE TABLE IF NOT EXISTS discovery_pql_events (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  idea_id uuid,
  prospect_key text NOT NULL,
  def_id uuid,                                     -- soft ref (no FK) to the qualifying definition
  def_kind text NOT NULL,
  score integer NOT NULL DEFAULT 0,                -- 0–100 likelihood — UNVERIFIED
  verified boolean NOT NULL DEFAULT false,         -- true only when externally grounded
  qualifying_signals jsonb NOT NULL DEFAULT '[]'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT discovery_pql_events_score_ck CHECK (score >= 0 AND score <= 100),
  CONSTRAINT discovery_pql_events_prospect_def_uk UNIQUE (workspace_id, prospect_key, def_id)
);
CREATE INDEX IF NOT EXISTS discovery_pql_events_idea_idx ON discovery_pql_events (workspace_id, idea_id);

-- 4. The 5-stage GTM pipeline membership: one row when a prospect enters a stage (outreach → discovery →
--    conversion → onboarding → post_sales). verified + external_ref mark an externally-grounded entry. One
--    row per (workspace, prospect, stage): re-entering is idempotent. Per-stage counts feed the founder
--    console growth panel (#104). READ-ONLY: the engine records the outreach entry (a prospect became a
--    who-to-reach-out-to) and a conversion entry on a verified conversion receipt.
CREATE TABLE IF NOT EXISTS discovery_pipeline_entries (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  idea_id uuid,
  prospect_key text NOT NULL,
  stage text NOT NULL,                             -- outreach | discovery | conversion | onboarding | post_sales
  verified boolean NOT NULL DEFAULT false,
  external_ref text,
  entered_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT discovery_pipeline_entries_stage_ck
    CHECK (stage IN ('outreach','discovery','conversion','onboarding','post_sales')),
  CONSTRAINT discovery_pipeline_entries_prospect_stage_uk UNIQUE (workspace_id, prospect_key, stage)
);
CREATE INDEX IF NOT EXISTS discovery_pipeline_entries_stage_idx ON discovery_pipeline_entries (workspace_id, stage);
