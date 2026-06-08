-- 0017_autonomy — cross-team agent pooling + autonomous activity loop (issue #17, ADR-0017).
-- All tables are workspace-scoped: "cross-team" means cross-channel WITHIN a workspace — the #3
-- tenant boundary is never crossed. Extends #9 (RBAC), #14 (tasks), #16 (shared memory),
-- #25 (server-owned runs) rather than reinventing them.

-- A named, discoverable pool of agents; pooled agents are shareable into channels ("teams").
CREATE TABLE agent_pools (
  id                    uuid PRIMARY KEY,
  workspace_id          uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name                  text NOT NULL,
  description           text,
  created_by_member_id  uuid REFERENCES members(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_pools_workspace_name_uniq UNIQUE (workspace_id, name)
);

-- An agent's pool membership + the roles (capability labels) it fills.
CREATE TABLE agent_pool_members (
  id                uuid PRIMARY KEY,
  workspace_id      uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  pool_id           uuid NOT NULL REFERENCES agent_pools(id) ON DELETE CASCADE,
  agent_member_id   uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  roles             jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_pool_members_uniq UNIQUE (pool_id, agent_member_id)
);
CREATE INDEX agent_pool_members_agent_idx ON agent_pool_members (workspace_id, agent_member_id);

-- Per-agent autonomy config + rate/cost guard state. Autonomy is OFF until enabled.
CREATE TABLE agent_autonomy (
  id                    uuid PRIMARY KEY,
  workspace_id          uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_member_id       uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  enabled               boolean NOT NULL DEFAULT false,
  max_actions_per_tick  integer NOT NULL DEFAULT 5,   -- rate guard
  action_budget         integer NOT NULL DEFAULT 100, -- cost guard (spend proxy)
  actions_used          integer NOT NULL DEFAULT 0,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_autonomy_workspace_agent_uniq UNIQUE (workspace_id, agent_member_id)
);

-- Per-workspace kill switch — halts every agent at once.
CREATE TABLE autonomy_controls (
  workspace_id          uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  kill_switch           boolean NOT NULL DEFAULT false,
  updated_by_member_id  uuid REFERENCES members(id) ON DELETE SET NULL,
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- A linear pipeline of stages over a #14 task, narrated into a channel.
CREATE TABLE agent_workflows (
  id                    uuid PRIMARY KEY,
  workspace_id          uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_id            uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  task_id               uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  stages                jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{agentMemberId, role}]
  current_stage         integer NOT NULL DEFAULT 0,
  status                text NOT NULL DEFAULT 'running',
  action_count          integer NOT NULL DEFAULT 0,          -- loop guard
  created_by_member_id  uuid REFERENCES members(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_workflows_task_uniq UNIQUE (task_id),
  CONSTRAINT agent_workflows_status_ck CHECK (
    status IN ('running', 'awaiting_approval', 'completed', 'canceled')
  )
);
CREATE INDEX agent_workflows_workspace_status_idx ON agent_workflows (workspace_id, status);

-- An approval gate: the agent creates a pending row; a human decides (agents can't self-approve).
CREATE TABLE agent_approvals (
  id                    uuid PRIMARY KEY,
  workspace_id          uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workflow_id           uuid REFERENCES agent_workflows(id) ON DELETE CASCADE,
  task_id               uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  requested_by_member_id uuid REFERENCES members(id) ON DELETE SET NULL,
  action                text NOT NULL,
  status                text NOT NULL DEFAULT 'pending',
  decided_by_member_id  uuid REFERENCES members(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  decided_at            timestamptz,
  CONSTRAINT agent_approvals_status_ck CHECK (status IN ('pending', 'approved', 'rejected'))
);
CREATE INDEX agent_approvals_workspace_status_idx ON agent_approvals (workspace_id, status);
