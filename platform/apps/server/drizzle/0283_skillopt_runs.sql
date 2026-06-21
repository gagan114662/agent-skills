-- SkillOpt-Sleep run persistence (#283, ADR-0283) — the durable AUDIT LEDGER for the offline
-- self-improvement loop. The pure cycle (src/skillopt/) already harvests → mines → gates → stages a
-- bounded proposal in the #13 queue; this adds the missing persistence so a nightly run is recorded and the
-- loop can MEASURE itself (the before/after validation signal) and stay idempotent (never re-stage the same
-- edit against the same doc). Two additive, workspace-scoped tables — a run header + one row per agent
-- outcome. Numbered 0283 by a free prefix (the issue number; per ADR-0099, to dodge sibling-workspace
-- collisions in the shared migration sequence).
--
-- Premortem (#200) is honored by construction: this table holds NO money and NO secret — it records that a
-- proposal was STAGED for the owner (the request_id links the #13 row), never that one was adopted. Adoption
-- stays human-gated in the approval queue; this ledger never grants new authority. Every text field is a
-- structural label or already-sanitized DATA written by the loop (#200 §6) — the loop reads transcripts as
-- DATA, never as instructions.
CREATE TABLE IF NOT EXISTS skillopt_runs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  enabled boolean NOT NULL,                            -- whether the loop was enabled for this workspace
  agents_processed integer NOT NULL DEFAULT 0,         -- fleet agents the cycle ran for
  staged_count integer NOT NULL DEFAULT 0,             -- proposals newly parked in the #13 queue this run
  deduped_count integer NOT NULL DEFAULT 0,            -- staged decisions suppressed as already-proposed
  skipped_count integer NOT NULL DEFAULT 0,            -- agents that produced no proposal (with a reason)
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS skillopt_runs_workspace_idx ON skillopt_runs (workspace_id, created_at);

-- One row per agent outcome of a run. For a STAGED outcome the validation columns carry the held-out,
-- externally-verified BEFORE/AFTER reading (baseline → candidate) and improvement_ratio — the measurable
-- self-improvement signal. For a SKIPPED/DEDUPED outcome they are null and skip_reason explains why. The
-- (agent_handle, cluster_key, current_doc_sha) triple is the idempotency key: once an edit is proposed
-- against a given doc it is never re-staged, so the loop stops re-proposing the same thing every night while
-- it is pending (and once adopted, the doc sha changes, so fresh proposals flow against the improved doc).
CREATE TABLE IF NOT EXISTS skillopt_proposals (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES skillopt_runs(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,  -- denormalized for tenant reads (#3)
  agent_handle text NOT NULL,                          -- the @handle whose skill doc the cycle improves
  skill_id text NOT NULL,                              -- the targeted skill doc (e.g. scout/runbook)
  status text NOT NULL,                                -- staged | deduped | skipped
  skip_reason text,                                    -- why no proposal was staged (skipped/deduped only)
  cluster_key text,                                    -- the mined recurring-task key the edit addresses
  metric text,                                         -- the validation metric id (e.g. email.reply_rate)
  higher_is_better boolean,                            -- metric orientation (false ⇒ lower-is-better)
  baseline double precision,                           -- BEFORE: metric under the current skill doc
  candidate double precision,                          -- AFTER:  metric under the proposed skill doc
  improvement_ratio double precision,                  -- the measured relative improvement (the signal)
  sample_size integer,                                 -- held-out replay size behind the reading
  externally_verified boolean,                         -- true ⇒ reading came from external receipts (#200 §2)
  current_doc_sha text,                                -- the doc sha the proposal pins (reversible adoption)
  request_id uuid REFERENCES approval_requests(id) ON DELETE SET NULL,  -- the #13 request, if staged
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS skillopt_proposals_run_idx ON skillopt_proposals (run_id);
CREATE INDEX IF NOT EXISTS skillopt_proposals_workspace_idx ON skillopt_proposals (workspace_id, created_at);
-- The idempotency lookup: "has this exact edit already been proposed against this doc?"
CREATE INDEX IF NOT EXISTS skillopt_proposals_dedup_idx
  ON skillopt_proposals (workspace_id, agent_handle, cluster_key, current_doc_sha);
