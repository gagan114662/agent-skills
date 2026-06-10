-- 0073_deployer — deploy agent-built apps to a live URL (issue #73, ADR-0041).
-- One row per deploy/redeploy/rollback. Each deploy is IMMUTABLE, so the row history is the backup
-- set and rollback re-promotes a prior `ready` one (rolled_back_from_id points at it). provider holds
-- the backend (dryrun | vercel); provider_deployment_id correlates to the provider's immutable id.
-- logs is a bounded, REDACTED tail (secrets scrubbed before persistence). Workspace/channel-scoped
-- for tenant isolation (#9).

CREATE TABLE deployments (
  id                      uuid PRIMARY KEY,
  workspace_id            uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_id              uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  session_id              uuid NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  provider                text NOT NULL,                       -- dryrun | vercel
  status                  text NOT NULL,                       -- queued|building|ready|error|unhealthy|rolled_back
  url                     text,                                -- live HTTPS URL once ready
  provider_deployment_id  text,                                -- the provider's immutable deployment id
  framework               text,                                -- detected/declared stack
  error                   text,                                -- redacted error/health detail
  reason                  text,                                -- deploy | push | rollback
  rolled_back_from_id     uuid REFERENCES deployments(id) ON DELETE SET NULL,
  logs                    jsonb NOT NULL DEFAULT '[]'::jsonb,  -- bounded, redacted log tail (string[])
  created_by_member_id    uuid REFERENCES members(id) ON DELETE SET NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX deployments_session_idx   ON deployments (session_id);
CREATE INDEX deployments_channel_idx   ON deployments (channel_id);
CREATE INDEX deployments_workspace_idx ON deployments (workspace_id);
