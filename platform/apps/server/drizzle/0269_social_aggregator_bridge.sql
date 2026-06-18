-- Echo social posting via the connect-once aggregator bridge (#269, ADR-0269): Echo drafts a post once and
-- the bridge fans it out to every connected network (X, LinkedIn, Instagram, TikTok, Facebook) through ONE
-- connection. Numbered 0269 by ISSUE (per ADR-0099) to dodge sibling-workspace collisions in the shared
-- migration sequence. Tenant boundary: workspace_id (#3, ON DELETE CASCADE).
--
-- Two tables. A post is stored as `draft`, parked behind the #13 owner gate as `pending_approval` (the HARD
-- constraint: a post — IRREVERSIBLE — never fans out without an explicit owner approval), then `published` /
-- `partially_published` / `scheduled` / `failed`. `approval_request_id` is the load-bearing column — a post
-- only fans out through an approval row (a soft ref so the receipt outlives a pruned approval).
-- `social_post_results` is the EXTERNAL-RECEIPT metric source: a network counts as published ONLY from a
-- recorded row carrying a real external_id, with its permalink read back from the aggregator API — never
-- self-reported. Names are intentionally NOT venture_/growth_/moat_-prefixed so the #155 colocation gate
-- does not class them as governed metric surfaces.

CREATE TABLE IF NOT EXISTS social_posts (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  body text NOT NULL,                               -- post content (DATA — never parsed for routing)
  networks text NOT NULL,                           -- comma-joined validated allow-list of target networks
  scheduled_at timestamptz,                          -- null ⇒ post on approval; else the aggregator schedules
  status text NOT NULL DEFAULT 'draft',             -- draft | pending_approval | scheduled | published | partially_published | failed
  approval_request_id uuid,                         -- soft ref to the #13 approval that authorized the fan-out
  aggregator_ref text,                              -- the bridge's overall post id, set at publish
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT social_posts_status_ck CHECK (
    status IN ('draft','pending_approval','scheduled','published','partially_published','failed')
  )
);

CREATE INDEX IF NOT EXISTS social_posts_workspace_idx ON social_posts (workspace_id, created_at);

CREATE TABLE IF NOT EXISTS social_post_results (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  post_id uuid NOT NULL REFERENCES social_posts(id) ON DELETE CASCADE,
  network text NOT NULL,                             -- the target network this receipt is for
  status text NOT NULL,                             -- published | scheduled | failed
  external_id text,                                 -- the network's real post id — the EXTERNAL receipt
  permalink text,                                   -- live permalink read back from the aggregator API
  error text,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT social_post_results_status_ck CHECK (status IN ('published','scheduled','failed'))
);

CREATE INDEX IF NOT EXISTS social_post_results_post_idx ON social_post_results (post_id);
CREATE INDEX IF NOT EXISTS social_post_results_workspace_idx ON social_post_results (workspace_id);
