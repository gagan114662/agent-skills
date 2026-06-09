-- 0026_git_pr_review — git worktree / PR / diff / review workflow (issue #51, ADR-0028).
-- Builds on #25 agent_sessions: each session can run in a git worktree on branch agent/<id>; its
-- work becomes a reviewable diff, an optional GitHub PR, and review comments that route back to the
-- agent as a new session. Every row is workspace + channel scoped (tenant-/IDOR-safe like #25).

-- A session's git refs. Nullable: non-git sessions (#25 default) leave them unset.
ALTER TABLE agent_sessions ADD COLUMN branch       text;
ALTER TABLE agent_sessions ADD COLUMN base_branch  text;
ALTER TABLE agent_sessions ADD COLUMN head_sha     text;

-- A pull request opened from a session's branch. The GitHub number/url are filled by the provider;
-- with the 'none' provider a PR cannot be created (route 501), so a persisted row always has them.
CREATE TABLE pull_requests (
  id                    uuid PRIMARY KEY,
  workspace_id          uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_id            uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  -- the session whose branch this PR ships; nullable so a session can be pruned without losing the PR
  session_id            uuid REFERENCES agent_sessions(id) ON DELETE SET NULL,
  number                integer,          -- GitHub PR number (null until the provider returns one)
  url                   text,             -- GitHub PR url
  title                 text NOT NULL,
  body                  text,
  draft                 boolean NOT NULL DEFAULT false,
  state                 text NOT NULL DEFAULT 'open',     -- 'draft' | 'open' | 'merged' | 'closed'
  checks_status         text NOT NULL DEFAULT 'unknown',  -- 'unknown' | 'pending' | 'success' | 'failure'
  base_branch           text NOT NULL,
  head_branch           text NOT NULL,
  provider              text NOT NULL DEFAULT 'none',     -- 'none' | 'gh'
  created_by_member_id  uuid REFERENCES members(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pull_requests_state_ck CHECK (state IN ('draft', 'open', 'merged', 'closed')),
  CONSTRAINT pull_requests_checks_ck CHECK (checks_status IN ('unknown', 'pending', 'success', 'failure')),
  CONSTRAINT pull_requests_provider_ck CHECK (provider IN ('none', 'gh'))
);

CREATE INDEX pull_requests_channel_idx ON pull_requests (channel_id, created_at);
CREATE INDEX pull_requests_session_idx ON pull_requests (session_id);

-- A review comment on a session's diff. Multiline (line_start..line_end) and optionally tied to a PR.
-- delivered_to_session_id records the follow-up session a comment was forwarded to — the round-trip
-- evidence that "a diff comment was delivered to the agent and it ran again to address it".
CREATE TABLE review_comments (
  id                       uuid PRIMARY KEY,
  workspace_id             uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_id               uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  session_id               uuid NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  pull_request_id          uuid REFERENCES pull_requests(id) ON DELETE SET NULL,
  file_path                text NOT NULL,
  line_start               integer,
  line_end                 integer,
  body                     text NOT NULL,
  author_member_id         uuid REFERENCES members(id) ON DELETE SET NULL,
  -- the new agent session this comment was delivered to (null until delivered)
  delivered_to_session_id  uuid REFERENCES agent_sessions(id) ON DELETE SET NULL,
  created_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX review_comments_channel_idx ON review_comments (channel_id, created_at);
CREATE INDEX review_comments_session_idx ON review_comments (session_id);
