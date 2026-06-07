-- Reverse of 0006_threads_mentions.
DROP INDEX IF EXISTS message_mentions_member_idx;
DROP TABLE IF EXISTS message_mentions;
ALTER TABLE messages DROP COLUMN IF EXISTS also_sent_to_channel;
