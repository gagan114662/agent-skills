-- ipop hosted publishing (#266, ADR-0266): multi-tenant customer blogs + landing pages with ZERO repo and
-- ZERO deploy the customer can see. Numbered 0266 by ISSUE (per ADR-0099) to dodge sibling-workspace
-- collisions in the shared migration sequence. Tenant boundary: workspace_id (#3, ON DELETE CASCADE).
--
-- Three tables. A page is rendered + stored as `draft`, parked behind the #13 owner gate as
-- `pending_approval` (the HARD constraint: nothing goes live without an explicit owner approval), then
-- `published` (live, with a cached `public_url`) and reversibly `unpublished`. `approval_request_id` is the
-- load-bearing column — a page only reaches `published` through an approval row (a soft ref so the receipt
-- outlives a pruned approval). `hosted_page_views` is the EXTERNAL-RECEIPT metric source: page-view counts
-- are read only from recorded rows, never self-reported. Names are intentionally NOT venture_/growth_/moat_-
-- prefixed so the #155 colocation gate does not class them as governed metric surfaces.

CREATE TABLE IF NOT EXISTS hosted_sites (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  subdomain text NOT NULL,                          -- globally-unique free ipop subdomain (<sub>.sites.ipop.app)
  custom_domain text,                               -- optional; served only once verified
  domain_verified boolean NOT NULL DEFAULT false,   -- flipped by the #264 DNS verification flow
  name text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS hosted_sites_subdomain_uq ON hosted_sites (subdomain);
CREATE INDEX IF NOT EXISTS hosted_sites_workspace_idx ON hosted_sites (workspace_id);

CREATE TABLE IF NOT EXISTS hosted_pages (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  site_id uuid NOT NULL REFERENCES hosted_sites(id) ON DELETE CASCADE,
  kind text NOT NULL,                               -- article | landing
  slug text NOT NULL,                               -- traversal-proof [a-z0-9-]
  title text NOT NULL,
  body text NOT NULL,
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft',             -- draft | pending_approval | published | unpublished
  html text,                                        -- rendered document, cached at publish
  public_url text,                                  -- canonical live URL, set at publish
  approval_request_id uuid,                         -- soft ref to the #13 approval that authorized publish
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hosted_pages_kind_ck CHECK (kind IN ('article','landing')),
  CONSTRAINT hosted_pages_status_ck CHECK (status IN ('draft','pending_approval','published','unpublished'))
);

CREATE UNIQUE INDEX IF NOT EXISTS hosted_pages_site_slug_uq ON hosted_pages (site_id, slug);
CREATE INDEX IF NOT EXISTS hosted_pages_workspace_idx ON hosted_pages (workspace_id);

CREATE TABLE IF NOT EXISTS hosted_page_views (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  page_id uuid NOT NULL REFERENCES hosted_pages(id) ON DELETE CASCADE,
  referrer text,
  viewed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS hosted_page_views_page_idx ON hosted_page_views (page_id, viewed_at);
