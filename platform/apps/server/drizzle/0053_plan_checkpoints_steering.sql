-- 0053_plan_checkpoints_steering — plan mode, checkpoints & steering (issue #53, ADR-0030).
-- plan_proposals: an agent proposes a plan (plan-mode run, AGENT_PLAN_MODE=1) and WORK BLOCKS until a
--   human approves / approves-with-feedback / rejects; on approval the execution session is launched
--   and stamped here. session_turns: a per-session checkpoint ledger — each turn carries the files
--   snapshot (head_sha) + conversation cursor (cursor_message_id) so a revert restores both. Neither
--   table holds secrets; both are workspace + channel scoped (#3/#19).

CREATE TABLE plan_proposals (
  id                    uuid PRIMARY KEY,
  workspace_id          uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_id            uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  agent_member_id       uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  plan_session_id       uuid REFERENCES agent_sessions(id) ON DELETE SET NULL,
  original_task         text NOT NULL,
  plan_text             text NOT NULL,
  status                text NOT NULL DEFAULT 'proposed',
  feedback              text,
  execution_session_id  uuid REFERENCES agent_sessions(id) ON DELETE SET NULL,
  created_by_member_id  uuid REFERENCES members(id) ON DELETE SET NULL,
  decided_by_member_id  uuid REFERENCES members(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  decided_at            timestamptz,
  CONSTRAINT plan_proposals_status_ck
    CHECK (status IN ('proposed', 'approved', 'approved_with_feedback', 'rejected'))
);

CREATE INDEX plan_proposals_channel_idx ON plan_proposals (channel_id, created_at);

CREATE TABLE session_turns (
  id                    uuid PRIMARY KEY,
  workspace_id          uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_id            uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  session_id            uuid NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  idx                   integer NOT NULL,                 -- 0-based; idx 0 is the baseline
  kind                  text NOT NULL DEFAULT 'work',
  head_sha              text,                             -- worktree snapshot (files half)
  cursor_message_id     uuid REFERENCES messages(id) ON DELETE SET NULL,  -- conversation cursor
  plan_proposal_id      uuid REFERENCES plan_proposals(id) ON DELETE SET NULL,
  created_by_member_id  uuid REFERENCES members(id) ON DELETE SET NULL,
  reverted_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT session_turns_kind_ck CHECK (kind IN ('baseline', 'work')),
  CONSTRAINT session_turns_session_idx_uq UNIQUE (session_id, idx)
);

CREATE INDEX session_turns_session_idx ON session_turns (session_id, idx);
