-- 0503_agent_decisions — the shared decision store (issue #513).
-- The structured, queryable spine the #15/#16 memory graph lacked for *decisions*: agents capture the
-- decisions they make and recall the ones their teammates made before, instead of re-deriving context
-- every run. Additive + reversible (paired 0503_agent_decisions.down.sql).
--
-- Holds NO secret and NO money: a decision is a record, never an action. Anything external/money it
-- implies is parked behind the #13 approval gate and only REFERENCED here (approval_request_id) — so this
-- migration's FKs to approval_requests/tasks/memories are references, never DDL on a governed table (#155).
-- id is supplied by the app via newId() (matching memory_files and every other table).
CREATE TABLE agent_decisions (
  id                          uuid PRIMARY KEY,
  workspace_id                uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  topic                       text NOT NULL,
  title                       text NOT NULL,
  rationale                   text NOT NULL,
  decided_by_member_id        uuid REFERENCES members(id) ON DELETE SET NULL,
  status                      text NOT NULL DEFAULT 'recorded',
  -- mirror into the #15 browsable graph (the `decision` node this row was captured as)
  memory_id                   uuid REFERENCES memories(id) ON DELETE SET NULL,
  -- optional #14 task this decision served
  task_id                     uuid REFERENCES tasks(id) ON DELETE SET NULL,
  -- the #13 approval request an external/money decision is parked behind (NULL for an internal decision)
  approval_request_id         uuid REFERENCES approval_requests(id) ON DELETE SET NULL,
  -- version history: a newer decision supersedes this one (kept, not deleted — mirrors #16)
  superseded_by_decision_id   uuid REFERENCES agent_decisions(id) ON DELETE SET NULL,
  dedupe_key                  text NOT NULL,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  superseded_at               timestamptz,
  CONSTRAINT agent_decisions_dedupe_uniq UNIQUE (workspace_id, dedupe_key),
  CONSTRAINT agent_decisions_status_chk CHECK (status IN ('recorded', 'superseded'))
);
-- recall by topic (the agent-facing query), and a cheap "live decisions" path for browse + the counter.
CREATE INDEX agent_decisions_topic_idx ON agent_decisions (workspace_id, topic);
CREATE INDEX agent_decisions_live_idx ON agent_decisions (workspace_id, created_at)
  WHERE superseded_by_decision_id IS NULL;
