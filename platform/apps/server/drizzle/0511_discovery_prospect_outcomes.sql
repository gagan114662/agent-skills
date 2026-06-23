-- Issue #612: win/loss close-out reasons for meaningful prospects.
CREATE TABLE IF NOT EXISTS discovery_prospect_outcomes (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE cascade,
  idea_id uuid,
  prospect_key text NOT NULL,
  outcome text NOT NULL,
  reason text NOT NULL,
  source text NOT NULL DEFAULT '',
  external_ref text,
  closed_at timestamptz NOT NULL DEFAULT now(),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT discovery_prospect_outcomes_outcome_ck CHECK (outcome IN ('won','lost'))
);

CREATE INDEX IF NOT EXISTS discovery_prospect_outcomes_workspace_idx
  ON discovery_prospect_outcomes(workspace_id);

CREATE INDEX IF NOT EXISTS discovery_prospect_outcomes_prospect_idx
  ON discovery_prospect_outcomes(workspace_id, prospect_key);

CREATE INDEX IF NOT EXISTS discovery_prospect_outcomes_reason_idx
  ON discovery_prospect_outcomes(workspace_id, outcome);
