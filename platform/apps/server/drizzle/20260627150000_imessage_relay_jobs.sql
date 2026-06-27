CREATE TABLE IF NOT EXISTS imessage_relay_jobs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  member_id uuid REFERENCES members(id) ON DELETE SET NULL,
  channel_id uuid REFERENCES channels(id) ON DELETE SET NULL,
  message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  purpose text NOT NULL,
  recipient text NOT NULL,
  service_name text,
  body text NOT NULL,
  receipt text,
  status text NOT NULL DEFAULT 'pending',
  locked_by text,
  locked_until timestamptz,
  sent_at timestamptz,
  failed_at timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT imessage_relay_jobs_purpose_ck CHECK (purpose IN ('verification','room','notification')),
  CONSTRAINT imessage_relay_jobs_status_ck CHECK (status IN ('pending','claimed','sent','failed'))
);

CREATE INDEX IF NOT EXISTS imessage_relay_jobs_status_created_idx
  ON imessage_relay_jobs(status, created_at);
CREATE INDEX IF NOT EXISTS imessage_relay_jobs_workspace_idx
  ON imessage_relay_jobs(workspace_id, created_at DESC);
