-- Insight Miner (#100, ADR-0100): evidence-sourced secrets feeding the Venture Loop (#96) SOURCE stage.
-- Three workspace-scoped tables — the ranked candidate source list ("the list is the strategy"), the
-- structured mined insight, and the provenance trail (source URLs + recency) per insight.

-- The candidate source list, scored by evidence strength BEFORE mining (the "list is the strategy"
-- surface). kind classifies the asymmetry: pain sources (community/reviews/support_forum), why-now
-- deltas (api_changelog/regulation/pricing/model_capability), or the owner secret.
CREATE TABLE IF NOT EXISTS insight_sources (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind text NOT NULL,
  url text,
  title text NOT NULL DEFAULT '',
  observed_at timestamptz NOT NULL DEFAULT now(),
  evidence_strength integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'candidate',
  created_by_member_id uuid REFERENCES members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT insight_sources_kind_ck
    CHECK (kind IN ('community','reviews','support_forum','api_changelog','regulation','pricing','model_capability','owner_secret')),
  CONSTRAINT insight_sources_status_ck
    CHECK (status IN ('candidate','mined','skipped'))
);
CREATE INDEX IF NOT EXISTS insight_sources_workspace_status_idx ON insight_sources (workspace_id, status);
CREATE INDEX IF NOT EXISTS insight_sources_workspace_strength_idx ON insight_sources (workspace_id, evidence_strength);

-- The structured mined insight. Ranks by freshness × pain_intensity × competition_absence. dedupe_key
-- (sha256 of the normalized statement, reusing the #15 memory key) blocks a KILLed angle from
-- returning uncited. promoted_idea_id is the provenance link to the #96 venture idea it became.
CREATE TABLE IF NOT EXISTS insights (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind text NOT NULL,
  statement text NOT NULL,
  pain_intensity integer NOT NULL DEFAULT 0,
  competition_absence integer NOT NULL DEFAULT 0,
  freshness_at timestamptz NOT NULL DEFAULT now(),
  score integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'mined',
  dedupe_key text NOT NULL,
  promoted_idea_id uuid REFERENCES venture_ideas(id) ON DELETE SET NULL,
  source_id uuid REFERENCES insight_sources(id) ON DELETE SET NULL,
  created_by_member_id uuid REFERENCES members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT insights_kind_ck CHECK (kind IN ('pain','why_now','owner_secret')),
  CONSTRAINT insights_status_ck CHECK (status IN ('mined','promoted','killed','duplicate')),
  CONSTRAINT insights_pain_ck CHECK (pain_intensity BETWEEN 0 AND 10),
  CONSTRAINT insights_competition_ck CHECK (competition_absence BETWEEN 0 AND 10)
);
CREATE INDEX IF NOT EXISTS insights_workspace_status_idx ON insights (workspace_id, status);
CREATE INDEX IF NOT EXISTS insights_workspace_score_idx ON insights (workspace_id, score);
CREATE INDEX IF NOT EXISTS insights_workspace_dedupe_idx ON insights (workspace_id, dedupe_key);

-- The provenance trail: every insight carries source URLs + recency. A row is one cited claim. An
-- insight with at least one row whose source_url is non-empty is "cited" (the un-suppressible kind).
CREATE TABLE IF NOT EXISTS insight_evidence (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  insight_id uuid NOT NULL REFERENCES insights(id) ON DELETE CASCADE,
  source_url text,
  excerpt text NOT NULL DEFAULT '',
  observed_at timestamptz NOT NULL DEFAULT now(),
  source_id uuid REFERENCES insight_sources(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS insight_evidence_workspace_insight_idx ON insight_evidence (workspace_id, insight_id);
