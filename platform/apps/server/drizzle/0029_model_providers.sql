-- 0029_model_providers — multi-model / multi-provider selection (issue #52, ADR-0029).
-- Records the provider/model/effort/mode a session was launched with, for audit + the review UI.
-- These columns hold ONLY non-secret selection metadata — provider credentials never touch a row
-- (they flow through the #25 SecretsResolver and are redacted from output). All nullable: a session
-- launched without an explicit selection (or on the demo harness) leaves them unset — unchanged.

ALTER TABLE agent_sessions
  ADD COLUMN provider text,
  ADD COLUMN model    text,
  ADD COLUMN effort   text,
  ADD COLUMN mode     text;

ALTER TABLE agent_sessions
  ADD CONSTRAINT agent_sessions_provider_ck
    CHECK (provider IS NULL OR provider IN ('anthropic', 'openai', 'bedrock', 'vertex', 'custom')),
  ADD CONSTRAINT agent_sessions_effort_ck
    CHECK (effort IS NULL OR effort IN ('off', 'low', 'medium', 'high')),
  ADD CONSTRAINT agent_sessions_mode_ck
    CHECK (mode IS NULL OR mode IN ('single', 'auto'));
