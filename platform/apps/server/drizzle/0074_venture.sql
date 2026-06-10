-- Venture Loop (#96, ADR-0049): the YC-fundability gate for autonomous work.
-- Three workspace-scoped tables — the intake idea, the dual-persona scorecards, the iteration log.

CREATE TABLE IF NOT EXISTS venture_ideas (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  problem text NOT NULL,
  target_user text NOT NULL,
  insight text NOT NULL,
  wedge text NOT NULL,
  market_path text NOT NULL,
  status text NOT NULL DEFAULT 'intake',
  epic_task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
  created_by_member_id uuid REFERENCES members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT venture_ideas_status_ck
    CHECK (status IN ('intake','scoring','iterating','funded','killed','escalated'))
);
CREATE INDEX IF NOT EXISTS venture_ideas_workspace_status_idx ON venture_ideas (workspace_id, status);

CREATE TABLE IF NOT EXISTS venture_scorecards (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  idea_id uuid NOT NULL REFERENCES venture_ideas(id) ON DELETE CASCADE,
  iteration integer NOT NULL,
  score integer NOT NULL,
  verdict text,
  advocate jsonb NOT NULL DEFAULT '{}'::jsonb,
  reviewer jsonb NOT NULL DEFAULT '{}'::jsonb,
  reasoning text NOT NULL DEFAULT '',
  funded boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT venture_scorecards_verdict_ck
    CHECK (verdict IS NULL OR verdict IN ('FUND','ITERATE','KILL','ESCALATE'))
);
CREATE INDEX IF NOT EXISTS venture_scorecards_workspace_idea_idx ON venture_scorecards (workspace_id, idea_id);
CREATE INDEX IF NOT EXISTS venture_scorecards_workspace_expiry_idx ON venture_scorecards (workspace_id, expires_at);

CREATE TABLE IF NOT EXISTS venture_iterations (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  idea_id uuid NOT NULL REFERENCES venture_ideas(id) ON DELETE CASCADE,
  iteration integer NOT NULL,
  score integer NOT NULL,
  verdict text NOT NULL,
  gap_list jsonb NOT NULL DEFAULT '{}'::jsonb,
  angles jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  working_memory_summary text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT venture_iterations_verdict_ck
    CHECK (verdict IN ('FUND','ITERATE','KILL','ESCALATE'))
);
CREATE INDEX IF NOT EXISTS venture_iterations_workspace_idea_idx ON venture_iterations (workspace_id, idea_id);

-- Durable loop state (#96 hardening): the evaluation resumes from its last tick after a crash/restart
-- (no in-memory-only loop state). One active evaluation per idea; the scheduled tick advances it.
CREATE TABLE IF NOT EXISTS venture_evaluations (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  idea_id uuid NOT NULL REFERENCES venture_ideas(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'active',
  terminal_verdict text,
  current_iteration integer NOT NULL DEFAULT 0,
  failed_angles jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_score integer,
  cost_cents integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT venture_evaluations_idea_uniq UNIQUE (idea_id),
  CONSTRAINT venture_evaluations_status_ck CHECK (status IN ('active','terminal')),
  CONSTRAINT venture_evaluations_verdict_ck
    CHECK (terminal_verdict IS NULL OR terminal_verdict IN ('FUND','ITERATE','KILL','ESCALATE'))
);
CREATE INDEX IF NOT EXISTS venture_evaluations_workspace_status_idx ON venture_evaluations (workspace_id, status);
