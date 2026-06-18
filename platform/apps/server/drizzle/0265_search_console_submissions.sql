-- Search Console auto-submit receipts (#265, ADR-0265). One workspace-scoped table.
-- Numbered 0265 by ISSUE (per ADR-0099, to dodge sibling-workspace collisions in the shared sequence).
-- Tenant boundary: workspace_id (#3, ON DELETE CASCADE). The name is deliberately NOT venture_/growth_/
-- demand_/moat_-prefixed so the #155 colocation gate does not class it as a governed metric surface.
--
-- search_console_submissions — one row per sitemap-submission attempt and its EXTERNALLY-VERIFIED outcome
-- (premortem #200 §2: a success only counts when Google Search Console confirms it). status records the
-- lifecycle stage (pending_approval | submitted | verified | failed | rejected | not_connected); accepted is
-- TRUE only when Search Console confirmed the sitemap present with zero errors; indexed_pages is NULL when
-- unknown (never fabricated). With the default dry-run provider only the pre-approval states are ever
-- recorded, so the founder console's SEO tile stays honest.

CREATE TABLE IF NOT EXISTS search_console_submissions (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  site_url text NOT NULL,                            -- site origin the submission was scoped to
  sitemap_url text NOT NULL,                         -- submitted sitemap URL (always same-origin as site_url)
  status text NOT NULL,                              -- pending_approval | submitted | verified | failed | rejected | not_connected
  approval_request_id uuid,                          -- the #13 approval this parked / ran under
  provider text NOT NULL,                            -- dryrun | search_console
  accepted boolean NOT NULL DEFAULT false,           -- TRUE iff Search Console confirmed the sitemap (external proof)
  indexed_pages integer,                             -- indexed-page count Search Console reported, or NULL
  indexing_requested integer NOT NULL DEFAULT 0,     -- # of indexing requests sent for new/changed URLs
  detail text NOT NULL DEFAULT '',
  extra jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS search_console_submissions_workspace_created_idx
  ON search_console_submissions (workspace_id, created_at);
