-- Down: 0026_git_pr_review. Drop in dependency order (review_comments → pull_requests), then the
-- agent_sessions git columns. Mirrors the up migration exactly.
DROP TABLE IF EXISTS review_comments;
DROP TABLE IF EXISTS pull_requests;

ALTER TABLE agent_sessions DROP COLUMN IF EXISTS head_sha;
ALTER TABLE agent_sessions DROP COLUMN IF EXISTS base_branch;
ALTER TABLE agent_sessions DROP COLUMN IF EXISTS branch;
