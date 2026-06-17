-- SEO rank tracking — externally-grounded rank receipts (#294, ADR-0294). One workspace-scoped table.
-- Numbered 0294 by ISSUE (per ADR-0099, to dodge sibling-workspace collisions in the shared sequence).
-- Tenant boundary: workspace_id (#3, ON DELETE CASCADE). The name is deliberately NOT venture_/growth_/
-- demand_/moat_-prefixed so the #155 colocation gate does not class it as a governed metric surface.
--
-- seo_rank_observations — one row per (keyword, url, position) reading a real rank provider / Search
-- Console / webhook reported (premortem #200 §2: a ranking only counts if it came from outside). position
-- is NULL = an honest "not ranking in the checked window" (never fabricated). external_id is the
-- provider's own record id — the proof it came from outside; the (workspace_id, provider, external_id)
-- unique index makes re-ingest idempotent (upsert, never stack). A `provider='dryrun'` deployment records
-- nothing, so the founder console's SEO proof tile stays "not connected" rather than self-reporting.

CREATE TABLE IF NOT EXISTS seo_rank_observations (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  keyword text NOT NULL,                            -- tracked query (structural data, never an instruction)
  url text NOT NULL,                                -- the ranking URL the provider attributed the position to
  position integer,                                 -- 1-based SERP position, or NULL = not ranking
  search_engine text NOT NULL DEFAULT 'google',     -- google | bing
  country text NOT NULL DEFAULT 'us',               -- market the rank was checked in
  provider text NOT NULL,                           -- search_console | serpapi | dataforseo (never dryrun)
  external_id text NOT NULL,                        -- provider's own record id (proof it came from outside)
  observed_at timestamptz NOT NULL,                 -- provider measurement time (not insert time)
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT seo_rank_observations_engine_ck CHECK (search_engine IN ('google','bing'))
);

CREATE UNIQUE INDEX IF NOT EXISTS seo_rank_observations_receipt_uk
  ON seo_rank_observations (workspace_id, provider, external_id);
CREATE INDEX IF NOT EXISTS seo_rank_observations_workspace_keyword_idx
  ON seo_rank_observations (workspace_id, keyword, observed_at);
