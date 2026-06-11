-- YC Startup Constitution as enforced code (#146, ADR-0146).
-- Two additive changes: (1) a nullable go-to-market segment on the venture idea, so the Article I
-- love-gate can branch on B2B; (2) the durable feed of flagged constitution violations the Founder
-- Console reads and the flywheel learns from. No existing column or constraint changes — a deployment
-- with the constitution block OFF (the default) sees no behaviour change.

-- (1) Go-to-market segment (Article I). Nullable; null ⇒ the love-gate never bites (default-safe).
ALTER TABLE venture_ideas ADD COLUMN IF NOT EXISTS segment text;
ALTER TABLE venture_ideas
  ADD CONSTRAINT venture_ideas_segment_ck CHECK (segment IS NULL OR segment IN ('b2b','b2c'));

-- (2) The durable violation feed. workspace_id carries the #3 tenant boundary; idea_id cascades with
-- the venture idea. Violations FLAG (status open) — this is the audit trail, never a silent correction.
CREATE TABLE IF NOT EXISTS constitution_violations (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  idea_id uuid NOT NULL REFERENCES venture_ideas(id) ON DELETE CASCADE,
  article text NOT NULL,
  code text NOT NULL,
  severity text NOT NULL,
  stage text NOT NULL,
  verdict text NOT NULL,
  message text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT constitution_violations_severity_ck CHECK (severity IN ('block','high','medium','low')),
  CONSTRAINT constitution_violations_stage_ck CHECK (stage IN ('SOURCE','FUND','KILL')),
  CONSTRAINT constitution_violations_status_ck CHECK (status IN ('open','acknowledged'))
);
CREATE INDEX IF NOT EXISTS constitution_violations_workspace_status_idx
  ON constitution_violations (workspace_id, status);
CREATE INDEX IF NOT EXISTS constitution_violations_idea_idx
  ON constitution_violations (idea_id);
