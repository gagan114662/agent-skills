-- Decision-maker resolver (#223, ADR-0223): target account -> the right buyer + what they care about.
-- Numbered 0223 by ISSUE (per ADR-0099, to dodge sibling-workspace collisions in the shared migration
-- sequence). Tenant boundary: workspace_id (#3, ON DELETE CASCADE).
--
-- ONE table — the produced buyer briefs. This is the ONLY thing the resolver persists (#200 premortem:
-- nothing beyond the brief; no raw scraped profiles, no sensitive PII). Minimal personal data by design:
-- a public name, a public title, a buyer role — NO email / phone / address. Each hook in `hooks` carries
-- its cited public source URL and the quoted, sanitized evidence that grounds it (the video's "did you
-- actually read it?" gate, enforced in code: a hook with no successfully-read source never lands here).
--
-- account_id / idea_id are SOFT references (the #222 discovery account + #96 venture idea may be pruned
-- independently and the brief must outlive them); only workspace_id carries the FK + tenant boundary.

CREATE TABLE IF NOT EXISTS buyer_briefs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  idea_id uuid,                                    -- NULL = workspace-level brief (soft ref to #96)
  account_id text NOT NULL,                        -- soft ref to the #222 discovery account
  account_name text NOT NULL,
  account_domain text NOT NULL DEFAULT '',
  buyer_contact_id text NOT NULL,                  -- soft ref to a public contact in the #222 account
  buyer_name text NOT NULL,
  buyer_title text NOT NULL DEFAULT '',
  buyer_role text NOT NULL,                        -- champion | economic_buyer | agency | marketing | other
  rationale text NOT NULL,                         -- falsifiable "why this person"
  cares_about jsonb NOT NULL DEFAULT '[]'::jsonb,  -- bounded topic tags
  hooks jsonb NOT NULL DEFAULT '[]'::jsonb,        -- [{angle, sourceId, sourceUrl, retrievedAt, evidence}]
  fallback_trail jsonb NOT NULL DEFAULT '[]'::jsonb, -- higher-priority roles that were absent
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT buyer_briefs_role_ck
    CHECK (buyer_role IN ('champion','economic_buyer','agency','marketing','other'))
);

CREATE INDEX IF NOT EXISTS buyer_briefs_workspace_idx
  ON buyer_briefs (workspace_id, created_at);
CREATE INDEX IF NOT EXISTS buyer_briefs_workspace_account_idx
  ON buyer_briefs (workspace_id, account_id);
