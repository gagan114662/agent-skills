-- Ona-class agent infrastructure (#147, ADR-0147): automations + their durable run ledger.
-- Two workspace-scoped tables. The audit-trail and mission-control slices are read models over
-- existing rows (these runs, #13 approval events, #123 marketing tasks, #25 sessions) — no tables here.

-- (1) An automation definition: the owner's repeatable agent task on a trigger. enabled defaults false
-- (creating one never fires until opted in). schedule holds the cadence spec for a schedule trigger;
-- webhook_token_hash holds the sha-256 of the one-shown token for a webhook trigger. next_run_at is the
-- scheduler cursor (enabled AND next_run_at <= now = due). channel/member carry the #3 tenant boundary.
CREATE TABLE IF NOT EXISTS automations (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  trigger_kind text NOT NULL,
  schedule jsonb,
  webhook_token_hash text,
  template_key text NOT NULL,
  params jsonb NOT NULL DEFAULT '{}'::jsonb,
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  agent_handle text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  created_by_member_id uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  last_run_at timestamptz,
  next_run_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT automations_trigger_kind_ck CHECK (trigger_kind IN ('schedule','webhook'))
);
CREATE INDEX IF NOT EXISTS automations_workspace_idx ON automations (workspace_id);
CREATE INDEX IF NOT EXISTS automations_due_idx ON automations (enabled, next_run_at);

-- (2) The durable run ledger: every launch / skip / block / fail. Feeds the owner-visible audit trail.
-- session_id is a soft reference (no FK) so a run outlives a pruned session; the cascade rides
-- workspace_id / automation_id.
CREATE TABLE IF NOT EXISTS automation_runs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  automation_id uuid NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  trigger text NOT NULL,
  status text NOT NULL,
  reason text NOT NULL DEFAULT '',
  session_id uuid,
  task text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT automation_runs_trigger_ck CHECK (trigger IN ('schedule','webhook','manual')),
  CONSTRAINT automation_runs_status_ck CHECK (status IN ('launched','skipped','blocked','failed'))
);
CREATE INDEX IF NOT EXISTS automation_runs_workspace_created_idx ON automation_runs (workspace_id, created_at);
CREATE INDEX IF NOT EXISTS automation_runs_automation_idx ON automation_runs (automation_id);
