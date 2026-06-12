-- #171 (ADR-0171 §5): the Self-QA run audit trail. One row per synthetic-user E2E QA pass against the
-- live product — the run history the #104 founder console and any drift investigation read. Findings
-- themselves are NOT stored here: dedup lives in the #117 flywheel (the DB path) or in GitHub via the
-- body-marker (the CI path), so there is one dedup store, never two. Numbered by issue (ADR-0099) to
-- dodge sibling-workspace collisions in the shared migration sequence.
--
-- `workspace_id` carries the #3 tenant boundary (cascade) — every row lives under the dedicated,
-- tenant-isolated SYNTHETIC workspace, never a real customer's. Append-then-finish: a row is inserted
-- when a run starts and updated once when it finishes (status running → passed | failed).

CREATE TABLE IF NOT EXISTS selfqa_runs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  suite text NOT NULL,
  target text NOT NULL,
  status text NOT NULL DEFAULT 'running',
  checks_total integer NOT NULL DEFAULT 0,
  checks_failed integer NOT NULL DEFAULT 0,
  critical_count integer NOT NULL DEFAULT 0,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CONSTRAINT selfqa_runs_suite_ck CHECK (suite IN ('smoke','full')),
  CONSTRAINT selfqa_runs_status_ck CHECK (status IN ('running','passed','failed')),
  CONSTRAINT selfqa_runs_counts_ck CHECK (checks_total >= 0 AND checks_failed >= 0 AND critical_count >= 0)
);

CREATE INDEX IF NOT EXISTS selfqa_runs_workspace_started_idx ON selfqa_runs (workspace_id, started_at DESC);

-- Widen the #148 paging audit constraints so a critical self-QA finding can page the owner through the
-- SAME PagerService (acceptance criterion 4: reuse the #148 seam). Additive — existing sources/kinds keep
-- working; the down migration restores the prior, narrower checks.
ALTER TABLE reliability_pages DROP CONSTRAINT IF EXISTS reliability_pages_source_ck;
ALTER TABLE reliability_pages ADD CONSTRAINT reliability_pages_source_ck
  CHECK (source IN ('sre','uptime','selfqa'));
ALTER TABLE reliability_pages DROP CONSTRAINT IF EXISTS reliability_pages_kind_ck;
ALTER TABLE reliability_pages ADD CONSTRAINT reliability_pages_kind_ck
  CHECK (kind IN ('opened','repaged','resolved','uptime_down','uptime_recover','selfqa_critical'));
