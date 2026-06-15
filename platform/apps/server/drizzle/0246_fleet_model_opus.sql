-- Fleet model = claude-opus-4-8 via subscription only (#246). THE root cause of every agent crash
-- (live-confirmed 2026-06-15): the runtime was pinned to `claude-fable-5`, which the account 403s on
-- ("not available, please use Opus 4.8"), so every `claude -p --model claude-fable-5` session exited 1
-- producing nothing → "error · exit 1". #244 fixed the codebase DEFAULT but the deployed prod workspace
-- stayed pinned to Fable. Numbered 0246 by ISSUE (ADR-0099) to dodge sibling-branch prefix collisions.
--
-- 1. Add the per-workspace owner-picked model column (NON-secret; NULL ⇒ the deployment default
--    `ANTHROPIC_MODEL` → canonical `claude-opus-4-8`). The owner sets it via Settings → Connect Claude.
ALTER TABLE workspace_agent_credentials ADD COLUMN IF NOT EXISTS model text;

-- 2. Switch any existing workspace-level model override OFF the unservable `claude-fable-5` to the
--    canonical `claude-opus-4-8`, so an already-broken workspace is actually fixed, not just new ones.
--    Forward-safe + idempotent: a NULL/already-valid override is untouched.
UPDATE workspace_agent_credentials
   SET model = 'claude-opus-4-8', updated_at = now()
 WHERE model = 'claude-fable-5';
