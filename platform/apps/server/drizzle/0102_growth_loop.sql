-- Growth Loop (#102, ADR-0102): distribution instrumentation so launches don't die of obscurity.
-- Two workspace-scoped tables: (1) the durable growth-event log; (2) the channel-experiment ledger.
-- Numbered 0102 by issue (per ADR-0099's by-issue convention) to dodge sibling-workspace collisions.

-- (1) The append-only growth instrumentation log. One row per growth event (acquisition/activation/
-- conversion/retention, tagged with a traffic source). The pure funnel scorer (growth/score.ts)
-- aggregates these into a venture's 0–100 growth score. idea_id is a SOFT reference (no FK) so an event
-- outlives a pruned venture idea; only workspace_id carries the #3 tenant boundary (cascade).
CREATE TABLE IF NOT EXISTS growth_events (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  idea_id uuid,
  kind text NOT NULL,
  source text NOT NULL DEFAULT '',
  value integer NOT NULL DEFAULT 1,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT growth_events_kind_ck
    CHECK (kind IN ('acquisition','activation','conversion','retention'))
);
CREATE INDEX IF NOT EXISTS growth_events_workspace_idea_idx ON growth_events (workspace_id, idea_id);
CREATE INDEX IF NOT EXISTS growth_events_workspace_kind_idx ON growth_events (workspace_id, kind);

-- (2) The channel-experiment ledger: experiments proposed by the marketing fleet (#123). Promoting one
-- to an external post rides the existing external.send #13 gate (approval_request_id links the gated
-- request) — agents never publish autonomously. proposed_by_member_id / approval_request_id / idea_id
-- are SOFT references (no FK) so the experiment outlives a pruned member/approval/idea.
CREATE TABLE IF NOT EXISTS growth_experiments (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  idea_id uuid,
  channel text NOT NULL,
  hypothesis text NOT NULL,
  target_query text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'proposed',
  proposed_by_member_id uuid,
  approval_request_id uuid,
  result_summary text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT growth_experiments_status_ck
    CHECK (status IN ('proposed','approved','running','paused','completed','abandoned'))
);
CREATE INDEX IF NOT EXISTS growth_experiments_workspace_status_idx
  ON growth_experiments (workspace_id, status);
