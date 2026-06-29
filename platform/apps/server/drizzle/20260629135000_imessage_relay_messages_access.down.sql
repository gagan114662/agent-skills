ALTER TABLE imessage_relay_heartbeats
  DROP CONSTRAINT IF EXISTS imessage_relay_heartbeats_messages_access_ck;

ALTER TABLE imessage_relay_heartbeats
  DROP COLUMN IF EXISTS messages_access;
