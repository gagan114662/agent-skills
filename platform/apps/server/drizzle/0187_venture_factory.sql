-- Venture Factory (#187, ADR-0187): idea → validated → launched venture on autopilot.
-- Numbered 0187 by ISSUE (per ADR-0099, to dodge sibling-workspace collisions in the shared migration
-- sequence). Tenant boundary: workspace_id (#3, onDelete cascade). candidate_id cascades (same
-- migration). Cross-entity links (venture_idea_id, approval_request_id) are SOFT references — no FK —
-- so a record outlives a pruned idea/approval (the #197 persistence discipline).
--
-- The whole factory answers to the premortem (#200): no row here becomes a company without a qualifying
-- EDGE (FM#1, edge_status), and a validation scorecard is built from EXTERNAL receipts only (FM#2,
-- receipts jsonb), with derived CAC/score labeled UNVERIFIED in the application layer.

-- A scored opportunity candidate filed by the lens/scout scanner, with its evidence + falsifiable edge.
CREATE TABLE IF NOT EXISTS factory_candidates (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source text NOT NULL,                            -- 'lens' | 'scout' | 'owner'
  thesis text NOT NULL,
  proposed_name text NOT NULL,
  pain_intensity integer NOT NULL,
  competition_absence integer NOT NULL,
  observed_at timestamptz NOT NULL,
  citations jsonb NOT NULL DEFAULT '[]'::jsonb,
  score integer NOT NULL,                          -- 0–100 multiplicative opportunity score
  edge_claims jsonb NOT NULL DEFAULT '[]'::jsonb,  -- EdgeClaim[] (the FM#1 gate input)
  edge_status text NOT NULL DEFAULT 'unevaluated', -- 'unevaluated' | 'qualified' | 'rejected'
  status text NOT NULL DEFAULT 'scanned',
  created_by_member_id uuid REFERENCES members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT factory_candidates_source_ck CHECK (source IN ('lens','scout','owner')),
  CONSTRAINT factory_candidates_edge_status_ck CHECK (edge_status IN ('unevaluated','qualified','rejected')),
  CONSTRAINT factory_candidates_status_ck CHECK (status IN ('scanned','validating','validated','bootstrap_pending','launched','killed'))
);
CREATE INDEX IF NOT EXISTS factory_candidates_workspace_status_idx ON factory_candidates (workspace_id, status);
CREATE INDEX IF NOT EXISTS factory_candidates_workspace_score_idx ON factory_candidates (workspace_id, score);
CREATE INDEX IF NOT EXISTS factory_candidates_workspace_created_idx ON factory_candidates (workspace_id, created_at);

-- One validation experiment per candidate (the smoke test) — external receipts + the derived scorecard.
CREATE TABLE IF NOT EXISTS factory_validations (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  candidate_id uuid NOT NULL REFERENCES factory_candidates(id) ON DELETE CASCADE,
  budget_cap_cents integer NOT NULL,               -- HARD cap: spend may never exceed this
  spent_cents integer NOT NULL DEFAULT 0,
  signups integer NOT NULL DEFAULT 0,
  cac_cents integer,                               -- spend ÷ signups; NULL at zero signups (UNVERIFIED)
  score integer NOT NULL DEFAULT 0,                -- derived 0–100 (UNVERIFIED — never decides alone)
  verdict text,                                    -- 'PROMOTE' | 'KILL' | 'INCONCLUSIVE' | NULL
  status text NOT NULL DEFAULT 'running',          -- 'running' | 'concluded'
  receipts jsonb NOT NULL DEFAULT '[]'::jsonb,     -- ValidationReceipt[] (EXTERNAL only, FM#2)
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT factory_validations_verdict_ck CHECK (verdict IS NULL OR verdict IN ('PROMOTE','KILL','INCONCLUSIVE')),
  CONSTRAINT factory_validations_status_ck CHECK (status IN ('running','concluded')),
  -- one experiment per candidate: a repeat is an idempotent no-op
  CONSTRAINT factory_validations_candidate_uk UNIQUE (workspace_id, candidate_id)
);
CREATE INDEX IF NOT EXISTS factory_validations_workspace_status_idx ON factory_validations (workspace_id, status);

-- A bootstrapped, live venture — idempotent (one per candidate). venture_idea_id / approval_request_id
-- are SOFT refs (no FK) so the record survives a pruned idea/approval.
CREATE TABLE IF NOT EXISTS factory_ventures (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  candidate_id uuid NOT NULL REFERENCES factory_candidates(id) ON DELETE CASCADE,
  venture_idea_id uuid,                            -- soft ref to the #96 idea (null until linked)
  name text NOT NULL,
  status text NOT NULL DEFAULT 'launching',        -- 'launching' | 'launched' | 'archived'
  approval_request_id uuid,                         -- soft ref to the venture.bootstrap #13 gate
  created_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  CONSTRAINT factory_ventures_status_ck CHECK (status IN ('launching','launched','archived')),
  -- idempotent bootstrap: one factory venture per candidate
  CONSTRAINT factory_ventures_candidate_uk UNIQUE (workspace_id, candidate_id)
);
CREATE INDEX IF NOT EXISTS factory_ventures_workspace_status_idx ON factory_ventures (workspace_id, status);
