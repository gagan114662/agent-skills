-- Brand kit + asset store (#271, ADR-0271): images and brand assets for the marketing fleet. Two new
-- workspace-scoped tables + one tool-vocabulary extension. Numbered 0271 by ISSUE (per ADR-0099, to
-- dodge sibling-workspace collisions in the shared migration sequence). Tenant boundary: workspace_id
-- (#3, ON DELETE CASCADE).
--
-- `brand_kits` — the one-time brand identity the owner sets (palette/voice/logo). At most ONE `active`
-- kit per workspace (partial unique index); superseded kits become `archived` for provenance. Its
-- existence flips the founder-console brand proof tile to connected (#253).
--
-- `workspace_assets` — the per-workspace store of GENERATED + UPLOADED assets. `on_brand` records Mark's
-- verdict at store time; `brand_kit_id` stamps which kit it was checked against; `draft_ref` soft-links
-- the `agent.deliverable` approval card (#248) the asset was attached to. logo_asset_id / venture_id /
-- brand_kit_id / draft_ref are SOFT refs (no FK) so a receipt outlives a pruned venture/approval.
--
-- The `realworld_artifacts_tool_ck` CHECK is widened to admit the new `generate_image` tool so its
-- receipts (an audit + the console "real work" feed) insert (the receipt insert otherwise silently
-- swallows the constraint error). Names are deliberately NOT venture_/growth_-prefixed (#155 colocation).

CREATE TABLE IF NOT EXISTS brand_kits (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  palette jsonb NOT NULL DEFAULT '[]'::jsonb,        -- ordered list of #rrggbb (first = primary)
  voice text NOT NULL DEFAULT '',                    -- tone + do/don't the copy must follow
  logo_asset_id uuid,                                -- SOFT ref to workspace_assets (uploaded logo)
  status text NOT NULL DEFAULT 'active',             -- active | archived
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT brand_kits_status_ck CHECK (status IN ('active','archived'))
);

CREATE INDEX IF NOT EXISTS brand_kits_workspace_idx ON brand_kits (workspace_id, created_at);
-- The "set once" guarantee: at most one active kit per workspace (re-setting archives the old one).
CREATE UNIQUE INDEX IF NOT EXISTS brand_kits_one_active_idx
  ON brand_kits (workspace_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS workspace_assets (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  venture_id uuid,                                   -- SOFT ref (no FK)
  kind text NOT NULL,                                -- generated | uploaded
  mime text NOT NULL,                                -- e.g. image/svg+xml, image/png
  title text NOT NULL DEFAULT '',
  data text NOT NULL,                                -- data:/https: URI of the bytes
  brand_kit_id uuid,                                 -- SOFT ref: which kit it was checked against
  on_brand boolean NOT NULL DEFAULT false,           -- Mark's verdict at store time
  source_tool text NOT NULL,                         -- generate_image | store_asset | upload
  draft_ref uuid,                                    -- SOFT ref to the #248 agent.deliverable card
  provider text NOT NULL DEFAULT '',
  detail text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspace_assets_kind_ck CHECK (kind IN ('generated','uploaded')),
  CONSTRAINT workspace_assets_source_ck CHECK (source_tool IN ('generate_image','store_asset','upload'))
);

CREATE INDEX IF NOT EXISTS workspace_assets_workspace_created_idx
  ON workspace_assets (workspace_id, created_at);
CREATE INDEX IF NOT EXISTS workspace_assets_draft_idx
  ON workspace_assets (workspace_id, draft_ref);

-- Widen the real-world artifact tool CHECK to admit `generate_image` receipts.
ALTER TABLE realworld_artifacts DROP CONSTRAINT IF EXISTS realworld_artifacts_tool_ck;
ALTER TABLE realworld_artifacts ADD CONSTRAINT realworld_artifacts_tool_ck
  CHECK (tool IN ('publish','publish_site','send_email','post_social','browse','research','store_asset','generate_image','call_api'));
