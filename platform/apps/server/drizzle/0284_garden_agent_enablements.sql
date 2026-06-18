-- Agent Garden per-workspace enable state (#284, ADR-0284). One workspace-scoped table.
-- Numbered 0284 by ISSUE (per ADR-0099, to dodge sibling-workspace collisions in the shared sequence).
-- Tenant boundary: workspace_id (#3, ON DELETE CASCADE). The name is deliberately NOT growth_/demand_/
-- venture_/moat_-prefixed so the #155 colocation gate does not class it as a governed metric surface.
--
-- garden_agent_enablements — the owner's enable intent for each department agent in a workspace. One row
-- per (workspace, handle); the unique index makes a re-toggle idempotent (it updates the row, never
-- duplicates). An absent row means `disabled` (default OFF). The DISPLAYED on/off is reconciled against the
-- live persona roster in code (premortem #200 FM#3) — this table holds intent, not a verified metric, and
-- holds NO credential.

CREATE TABLE IF NOT EXISTS garden_agent_enablements (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  handle text NOT NULL,                              -- the @-mentionable fleet persona handle (lowercase)
  state text NOT NULL,                               -- enabled | pending_approval | disabled
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT garden_agent_enablements_state_ck
    CHECK (state IN ('enabled','pending_approval','disabled'))
);

CREATE UNIQUE INDEX IF NOT EXISTS garden_agent_enablements_workspace_handle_unique
  ON garden_agent_enablements (workspace_id, handle);
