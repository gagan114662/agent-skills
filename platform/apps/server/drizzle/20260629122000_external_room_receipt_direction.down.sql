DROP INDEX IF EXISTS external_room_message_receipts_readiness_idx;

ALTER TABLE external_room_message_receipts
  DROP CONSTRAINT IF EXISTS external_room_message_receipts_direction_ck;

ALTER TABLE external_room_message_receipts
  DROP COLUMN IF EXISTS direction;
