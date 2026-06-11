-- Moat Accrual (#103, ADR-0103): per-venture ledger of concrete moat accruals with provenance.
-- One workspace-scoped, append-only table. The pure moat score (moat/score.ts) is a projection of
-- these rows; the Founder Console (#104) reads them to flag ventures that have stopped compounding.
-- workspace_id carries the #3 tenant boundary (cascade); venture_idea_id cascades so a venture's
-- accruals die with it. dimension is CHECK-constrained to the four scored dimensions; magnitude >= 0.
CREATE TABLE IF NOT EXISTS moat_ledger (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  venture_idea_id uuid NOT NULL REFERENCES venture_ideas(id) ON DELETE CASCADE,
  dimension text NOT NULL,
  magnitude integer NOT NULL,
  unit text NOT NULL,
  description text NOT NULL DEFAULT '',
  provenance text NOT NULL,
  source_ref text,
  created_by_member_id uuid REFERENCES members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT moat_ledger_dimension_ck
    CHECK (dimension IN ('proprietaryData','switchingCosts','distributionLockIn','accumulatedEvals')),
  CONSTRAINT moat_ledger_magnitude_ck CHECK (magnitude >= 0)
);
CREATE INDEX IF NOT EXISTS moat_ledger_workspace_venture_idx
  ON moat_ledger (workspace_id, venture_idea_id);
CREATE INDEX IF NOT EXISTS moat_ledger_workspace_dimension_idx
  ON moat_ledger (workspace_id, dimension);
CREATE INDEX IF NOT EXISTS moat_ledger_workspace_created_idx
  ON moat_ledger (workspace_id, created_at);
