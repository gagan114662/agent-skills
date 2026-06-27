CREATE TABLE IF NOT EXISTS external_room_message_receipts (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  provider text NOT NULL,
  provider_conversation_id text NOT NULL,
  provider_message_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT external_room_message_receipts_provider_ck CHECK (provider IN ('telegram','whatsapp')),
  CONSTRAINT external_room_message_receipts_provider_message_uidx
    UNIQUE (provider, provider_conversation_id, provider_message_id)
);

CREATE INDEX IF NOT EXISTS external_room_message_receipts_message_idx
  ON external_room_message_receipts(message_id);
CREATE INDEX IF NOT EXISTS external_room_message_receipts_workspace_idx
  ON external_room_message_receipts(workspace_id, created_at DESC);
