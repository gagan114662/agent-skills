CREATE TABLE IF NOT EXISTS imessage_relay_inbound_receipts (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  reply_to_message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  sender text NOT NULL,
  receipt text NOT NULL,
  text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT imessage_relay_inbound_receipts_message_uidx UNIQUE (message_id)
);

CREATE INDEX IF NOT EXISTS imessage_relay_inbound_receipts_workspace_idx
  ON imessage_relay_inbound_receipts(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS imessage_relay_inbound_receipts_member_idx
  ON imessage_relay_inbound_receipts(workspace_id, member_id, created_at DESC);
