ALTER TABLE external_room_message_receipts
  ADD COLUMN IF NOT EXISTS direction text NOT NULL DEFAULT 'outbound';

ALTER TABLE external_room_message_receipts
  DROP CONSTRAINT IF EXISTS external_room_message_receipts_direction_ck;

ALTER TABLE external_room_message_receipts
  ADD CONSTRAINT external_room_message_receipts_direction_ck
    CHECK (direction IN ('outbound','inbound'));

CREATE INDEX IF NOT EXISTS external_room_message_receipts_readiness_idx
  ON external_room_message_receipts(workspace_id, provider, direction, created_at DESC);
