-- #155 (ADR-0155 §4): the eval-run audit trail — the maintenance-as-code latch from Anthropic's
-- self-service analytics playbook. One row per offline eval-suite run for an agent domain, carrying the
-- forensics a drift investigation needs: which skill version, which git SHA, which model, and the
-- pass/fail counts + tokens. Read by the CI before/after delta and the #117 flywheel (a regression becomes
-- an `eval_regression` failure event). Numbered by issue (ADR-0099) to dodge sibling-workspace collisions.
--
-- `workspace_id` carries the #3 tenant boundary (cascade); the run is otherwise self-contained (no soft
-- refs) so it outlives any pruned parent. Append-only — runs are never mutated, only inserted + read.

CREATE TABLE IF NOT EXISTS eval_runs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent text NOT NULL,
  suite_version text NOT NULL,
  git_sha text NOT NULL DEFAULT '',
  model_id text NOT NULL DEFAULT '',
  total integer NOT NULL,
  passed integer NOT NULL,
  failed integer NOT NULL,
  pass_rate integer NOT NULL, -- stored as basis points (0–10000) to keep the column integer + exact
  tokens integer NOT NULL DEFAULT 0,
  regressed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT eval_runs_counts_ck CHECK (passed >= 0 AND failed >= 0 AND total = passed + failed),
  CONSTRAINT eval_runs_pass_rate_ck CHECK (pass_rate >= 0 AND pass_rate <= 10000)
);

CREATE INDEX IF NOT EXISTS eval_runs_workspace_agent_idx ON eval_runs (workspace_id, agent, created_at DESC);
