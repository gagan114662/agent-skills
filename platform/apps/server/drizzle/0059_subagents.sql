-- 0059_subagents — custom subagents / agent personas (issue #59, ADR-0036).
-- A user-defined persona: a reusable system prompt + an allowed-tools ceiling (+ optional model),
-- paired with a materialized agent member so it is @-mentionable. Invoking it runs the real harness
-- (#50) AS agent_member_id, scoped to allowed_tools — bounded by that member's RBAC grants (#9), so a
-- subagent can never escalate privileges. Personas hold NO secrets.

CREATE TABLE agent_personas (
  id                    uuid PRIMARY KEY,
  workspace_id          uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- the @-mentionable agent member the session runs as / posts as
  agent_member_id       uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  -- the agent profile (for #9 deactivation / token revocation)
  agent_id              uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  name                  text NOT NULL,                       -- the @handle
  system_prompt         text NOT NULL,
  allowed_tools         jsonb NOT NULL DEFAULT '[]'::jsonb,  -- the tool ceiling (string[])
  model                 text,                                -- optional model override
  is_builtin            boolean NOT NULL DEFAULT false,
  created_by_member_id  uuid REFERENCES members(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_personas_workspace_name_uq UNIQUE (workspace_id, name)
);

CREATE INDEX agent_personas_workspace_idx ON agent_personas (workspace_id);
