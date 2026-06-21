-- 0506_agent_trace — the unified observation/replay trace (issue #560).
-- Observation today is partial (dr/verify readback receipts #200, evals, release receipts) but there is no
-- single per-run record of what each agent actually SAW and DID. These two tables are that record: an
-- append-only event log per agent run capturing every model request (system+messages+tools), every
-- response (incl reasoning), every tool call+result, and every #13 approval-gate decision — with
-- timestamps and token/cost — so any run can be opened and REPLAYED to reconstruct the decision path.
-- Additive + reversible (paired 0506_agent_trace.down.sql).
--
-- Holds NO live secret: every event payload is run through the #25 secret redactor (runtime/redact.ts)
-- AND a key-scrubber before it is persisted here, so a trace can never become a secret-exfil channel
-- (issue #25 boundary, #200 user-facing rule). ids are app-supplied via newId() (matching every table).
-- `agent_trace` is deliberately NOT a governed-metric prefix (tenant_usage/growth_/demand_/moat_/venture_)
-- so the #155 colocation gate does not class it as a metric surface — it is an observability log.

-- One row per agent run: the trace header + replay-ordering counter + token/cost rollup.
CREATE TABLE agent_trace_runs (
  id              uuid PRIMARY KEY,
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- the #25 agent_sessions run this traces, when one exists (a trace can also be opened standalone).
  session_id      uuid REFERENCES agent_sessions(id) ON DELETE SET NULL,
  agent_member_id uuid REFERENCES members(id) ON DELETE SET NULL,
  task_id         uuid REFERENCES tasks(id) ON DELETE SET NULL,
  label           text,
  status          text NOT NULL DEFAULT 'open',
  -- monotonic source for the next event's seq; bumped atomically as each event is appended (replay order).
  next_seq        integer NOT NULL DEFAULT 0,
  event_count     integer NOT NULL DEFAULT 0,
  input_tokens    bigint NOT NULL DEFAULT 0,
  output_tokens   bigint NOT NULL DEFAULT 0,
  cost_micros     bigint NOT NULL DEFAULT 0,
  started_at      timestamptz NOT NULL DEFAULT now(),
  ended_at        timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_trace_runs_status_chk CHECK (status IN ('open', 'closed'))
);
-- list a workspace's runs newest-first (the console timeline), and find the trace for a #25 session.
CREATE INDEX agent_trace_runs_ws_idx ON agent_trace_runs (workspace_id, started_at DESC);
CREATE INDEX agent_trace_runs_session_idx ON agent_trace_runs (session_id);

-- Append-only event log: every model request/response, tool call/result, and approval decision, in order.
-- Rows are INSERTed and never updated — `seq` (unique within a run) is the total replay order.
CREATE TABLE agent_trace_events (
  id            uuid PRIMARY KEY,
  run_id        uuid NOT NULL REFERENCES agent_trace_runs(id) ON DELETE CASCADE,
  -- denormalized for the #3 IDOR scope (every read filters by workspace_id) and cheap cascade on delete.
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  seq           integer NOT NULL,
  type          text NOT NULL,
  -- logical turn index (a request+its response+the tools it called share a turn) — groups the replay.
  turn          integer NOT NULL DEFAULT 0,
  label         text,
  -- the structured, ALREADY-REDACTED content (messages, tool args/result, reasoning, decision).
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  input_tokens  integer,
  output_tokens integer,
  cost_micros   bigint,
  -- when the event happened (caller-supplied; defaults to insert time).
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_trace_events_seq_uniq UNIQUE (run_id, seq),
  CONSTRAINT agent_trace_events_type_chk CHECK (
    type IN ('model_request', 'model_response', 'tool_call', 'tool_result', 'approval_decision')
  )
);
-- replay path: read one run's events in seq order, scoped to the workspace.
CREATE INDEX agent_trace_events_replay_idx ON agent_trace_events (workspace_id, run_id, seq);
