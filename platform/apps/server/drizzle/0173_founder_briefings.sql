-- Founder Briefings (#173, ADR-0173): the company reports to its owner — daily brief, weekly founder
-- report (per-venture P&L), one decision queue. Numbered 0173 by ISSUE (per ADR-0099, to dodge
-- sibling-workspace collisions in the shared migration sequence). Tenant boundary: workspace_id (#3).
--
-- ONE table — the delivery audit + idempotency watermark. This is the ONLY thing the reporting layer
-- writes: bookkeeping about its own sends (like #148 reliability_pages), NOT authority over any
-- business-domain table. The daily brief / weekly report / decision queue are all computed on demand by
-- read-only aggregation over existing tables (#98/#71/#107/#96/#114/#115/#146/#172/#13).
CREATE TABLE IF NOT EXISTS founder_briefings (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind text NOT NULL,
  period_key text NOT NULL,            -- 'YYYY-MM-DD' (daily) | ISO 'YYYY-Www' (weekly)
  delivered boolean NOT NULL,
  channels jsonb NOT NULL DEFAULT '[]'::jsonb,  -- per-channel results [{channel,delivered,reason}]
  word_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT founder_briefings_kind_ck CHECK (kind IN ('daily','weekly')),
  -- The idempotency watermark: one audited send per (workspace, kind, period). A repeat tick is a no-op.
  CONSTRAINT founder_briefings_period_uk UNIQUE (workspace_id, kind, period_key)
);
CREATE INDEX IF NOT EXISTS founder_briefings_workspace_idx
  ON founder_briefings (workspace_id, created_at DESC);
