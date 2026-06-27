CREATE TABLE IF NOT EXISTS imessage_relay_heartbeats (
  relay_id text PRIMARY KEY,
  host text NOT NULL,
  version text,
  checked_in_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS imessage_relay_heartbeats_checked_in_idx
  ON imessage_relay_heartbeats(checked_in_at DESC);
