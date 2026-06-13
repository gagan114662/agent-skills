-- Venture Memory & Planning (#197, ADR-0197): the company remembers, learns, and plans across weeks.
-- Numbered 0197 by ISSUE (per ADR-0099, to dodge sibling-workspace collisions in the shared migration
-- sequence). Tenant boundary: workspace_id (#3, onDelete cascade). All cross-entity links (idea_id,
-- approval_request_id, source_ref, provenance verifier ids) are SOFT references — no FK — so a record
-- outlives a pruned idea/approval (the #115/#117 persistence discipline).
--
-- NOTE: venture MEMORY itself is NOT a new table — it reuses the #15 `memories` table tagged
-- `entity = venture:<ideaId>`, `type = venture_memory`. These three tables add the OKRs, the weekly
-- plans, and the cross-venture playbooks the memory feeds.

-- 2–3 measurable objectives per venture. Each key result carries whether it is externally verified
-- (#106) and its source — an unverified KR can never read "on track" in the pure drift computation.
CREATE TABLE IF NOT EXISTS venture_okrs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  idea_id uuid NOT NULL,                       -- soft ref to the venture idea (#96)
  objective text NOT NULL,
  -- [{ metric, target (number), current (number), unit, verified (bool), source (text|null) }]
  key_results jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'active',
  period_key text NOT NULL DEFAULT '',         -- the objective's window label (e.g. a quarter/week)
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT venture_okrs_status_ck CHECK (status IN ('active','achieved','missed','archived'))
);
CREATE INDEX IF NOT EXISTS venture_okrs_workspace_idea_idx ON venture_okrs (workspace_id, idea_id);

-- One drafted weekly plan per venture per ISO week. The plan lands as a pending #13 request (surfacing
-- in the #173 decision queue); on approval its items become #115 backlog rows that auto-dispatch (#172).
-- go_no_go is 'no_go' unless the venture has an externally-verified (#106) metric; premortem_cited is
-- NOT NULL DEFAULT true — the drafter refuses to persist a plan without citing #200.
CREATE TABLE IF NOT EXISTS venture_plans (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  idea_id uuid NOT NULL,                       -- soft ref to the venture idea (#96)
  week_key text NOT NULL,                      -- ISO week 'YYYY-Www'
  status text NOT NULL DEFAULT 'draft',
  go_no_go text NOT NULL DEFAULT 'no_go',
  -- the go/no-go rationale, citing #200 + the failure modes it answers
  rationale text NOT NULL DEFAULT '',
  premortem_cited boolean NOT NULL DEFAULT true,
  -- [{ title, why, estimateLabel:'UNVERIFIED', source, sourceRef, severityTier, signalCount,
  --    corroboratingSources, effortPoints }]
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  approval_request_id uuid,                     -- soft ref to the #13 gate, or null until enqueued
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT venture_plans_status_ck CHECK (status IN ('draft','approved','rejected','dispatched')),
  CONSTRAINT venture_plans_gonogo_ck CHECK (go_no_go IN ('go','no_go')),
  -- one plan per venture per week: a repeat tick is an idempotent no-op (the watermark)
  CONSTRAINT venture_plans_week_uk UNIQUE (workspace_id, idea_id, week_key)
);
CREATE INDEX IF NOT EXISTS venture_plans_workspace_status_idx ON venture_plans (workspace_id, status);

-- Cross-venture anonymized playbooks: a reusable pattern (no venture-identifying text) plus provenance
-- carrying a HASH of each source venture id (lineage without leaking which venture), the outcome, and
-- the #106 verifier receipt that earned it. Tenant-scoped (#3): "cross-venture" = across one owner's
-- ventures, never cross-tenant. dedupe_key makes distillation idempotent.
CREATE TABLE IF NOT EXISTS venture_playbooks (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  category text NOT NULL DEFAULT 'general',
  pattern text NOT NULL,
  -- [{ sourceVentureHash, outcome, evidence, verifierResultId (text|null) }]
  provenance jsonb NOT NULL DEFAULT '[]'::jsonb,
  dedupe_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT venture_playbooks_dedupe_uk UNIQUE (workspace_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS venture_playbooks_workspace_category_idx
  ON venture_playbooks (workspace_id, category);
