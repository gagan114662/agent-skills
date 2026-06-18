-- Durable-workflow runs (#338, ADR-0338): the persisted place of a long-running step that SUSPENDS,
-- RESUMES, RETRIES-with-backoff, and PERSISTS its state instead of blocking the event loop on a hand-rolled
-- `while (Date.now() < deadline) { …; await sleep }` poll (the symptom the issue names: the overnight loop
-- that froze on a blocking `until` wait). Numbered 0338 by ISSUE (per ADR-0099, to dodge sibling-workspace
-- collisions in the shared migration sequence). Tenant boundary: workspace_id (#3, ON DELETE CASCADE).
--
-- ONE table, modeled on build_loop_runs (#172). unique(workspace_id, idempotency_key) makes "one run per
-- logical job" a database invariant — the structural guarantee behind "a resumed step never double-applies"
-- (premortem #200 §2). approval_request_id is the load-bearing column for the #13 always-gate (#200 §4): an
-- irreversible step cannot leave waiting_approval without it. It and state/result are SOFT references / opaque
-- payloads; only workspace_id carries the FK. deadline_at is the hard wall-clock budget (the no-hang bound).
-- The name is intentionally NOT venture_/growth_/moat_/demand_-prefixed so the #155 colocation gate does not
-- class it as a governed metric surface.

CREATE TABLE IF NOT EXISTS durable_runs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workflow_key text NOT NULL,                       -- the workflow kind (groups runs for observability)
  idempotency_key text NOT NULL,                    -- the dedup anchor within the workspace
  status text NOT NULL DEFAULT 'running',           -- running | suspended | waiting_approval | succeeded | failed | canceled
  attempts integer NOT NULL DEFAULT 0,              -- attempts of the current step already run (backoff/exhaustion counter)
  next_attempt_at timestamptz,                      -- when the next attempt is eligible (backoff cursor), or null
  deadline_at timestamptz NOT NULL,                 -- hard wall-clock deadline (the no-hang bound)
  requires_approval boolean NOT NULL DEFAULT false, -- irreversible step (#200 §4) → needs an approval to advance
  approval_request_id uuid,                         -- soft ref to the #13 approval authorizing an irreversible step
  state jsonb NOT NULL DEFAULT '{}'::jsonb,          -- caller state carried across suspensions (opaque to the engine)
  result jsonb,                                     -- the terminal result, persisted on success (read back on resume)
  error text,                                       -- short redacted failure reason when status = failed
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT durable_runs_status_ck CHECK (
    status IN ('running','suspended','waiting_approval','succeeded','failed','canceled')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS durable_runs_idempotency_uk
  ON durable_runs (workspace_id, idempotency_key);
CREATE INDEX IF NOT EXISTS durable_runs_workspace_status_idx
  ON durable_runs (workspace_id, status);
