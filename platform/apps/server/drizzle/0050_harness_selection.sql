-- 0050_harness_selection — per-session coding-agent harness selection (issue #50).
-- Records which harness a session ran on (demo / claude-code / codex), the per-session selection
-- that overrides the deployment default. Non-secret metadata only — the harness's auth (e.g.
-- OPENAI_API_KEY) flows through the #25 SecretsResolver and never touches a row. Nullable: rows
-- created before #50 leave it unset — unchanged.

ALTER TABLE agent_sessions
  ADD COLUMN harness text;

ALTER TABLE agent_sessions
  ADD CONSTRAINT agent_sessions_harness_ck
    CHECK (harness IS NULL OR harness IN ('demo', 'claude-code', 'codex'));
