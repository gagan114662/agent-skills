ALTER TABLE imessage_relay_heartbeats
  ADD COLUMN IF NOT EXISTS messages_access text NOT NULL DEFAULT 'unknown';

ALTER TABLE imessage_relay_heartbeats
  DROP CONSTRAINT IF EXISTS imessage_relay_heartbeats_messages_access_ck;

ALTER TABLE imessage_relay_heartbeats
  ADD CONSTRAINT imessage_relay_heartbeats_messages_access_ck
  CHECK (messages_access IN ('unknown','ok','failed'));
