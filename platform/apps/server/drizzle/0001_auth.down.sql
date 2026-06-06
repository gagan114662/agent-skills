-- Reverse of 0001_auth.
DROP TABLE IF EXISTS agent_tokens;
DROP TABLE IF EXISTS sessions;
ALTER TABLE users DROP COLUMN IF EXISTS password_hash;
