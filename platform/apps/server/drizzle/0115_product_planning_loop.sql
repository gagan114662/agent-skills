-- Product Planning Loop (#115, ADR-0115): feedback + metrics → RICE-ranked backlog → specs → agent
-- sessions, so after v1 the platform decides what to build next instead of polishing whatever it was
-- last told to. Two workspace-scoped tables. Numbered 0115 by issue (per ADR-0099's by-issue
-- convention) to dodge sibling-workspace collisions in the shared migration sequence.

-- (1) The RICE-scorable backlog. One row per candidate unit of work, sourced from evidence
-- (customer_voice/growth/verifier/manual) with a source_ref (the why-ranked-here link). The pure RICE
-- scorer (planning/rice.ts) ranks these; the score is DERIVED, never stored. idea_id / source_ref /
-- target_* / spec_id / approval_request_id are SOFT references (no FK) so a backlog item outlives a
-- pruned idea / member / channel / approval; only workspace_id carries the #3 tenant boundary (cascade).
CREATE TABLE IF NOT EXISTS backlog_items (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  idea_id uuid,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  source text NOT NULL,
  source_ref text NOT NULL DEFAULT '',
  reach integer NOT NULL DEFAULT 0,
  impact integer NOT NULL DEFAULT 0,
  confidence_pct integer NOT NULL DEFAULT 0,
  effort integer NOT NULL DEFAULT 1,
  is_pivot boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'proposed',
  target_channel_id uuid,
  target_agent_member_id uuid,
  spec_id uuid,
  approval_request_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT backlog_items_source_ck
    CHECK (source IN ('customer_voice','growth','verifier','manual')),
  CONSTRAINT backlog_items_status_ck
    CHECK (status IN ('proposed','specced','dispatched','done','rejected'))
);
CREATE INDEX IF NOT EXISTS backlog_items_workspace_status_idx ON backlog_items (workspace_id, status);
CREATE INDEX IF NOT EXISTS backlog_items_workspace_idea_idx ON backlog_items (workspace_id, idea_id);

-- (2) The drafted specs: the planning tick drafts a spec (repo lifecycle format) for the top-ranked
-- item. Promoting it to a build session rides the venture-gated #96 launcher; a sensitive item
-- (pivot / over-budget / not #95-allowed) rides the existing #13 gate (approval_request_id links the
-- gated request). backlog_item_id / session_id / approval_request_id are SOFT references (no FK).
CREATE TABLE IF NOT EXISTS planning_specs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  backlog_item_id uuid NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  session_id uuid,
  approval_request_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT planning_specs_status_ck
    CHECK (status IN ('draft','dispatched'))
);
CREATE INDEX IF NOT EXISTS planning_specs_workspace_item_idx ON planning_specs (workspace_id, backlog_item_id);
