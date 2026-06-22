-- Durable scheduler state (#559): ONE row per recurring job (planning / venture_memory / verifiers /
-- workflows), the persisted place of a tick cadence so it survives a process restart instead of living in
-- an in-process setInterval. Replaces `setInterval(() => this.tickAll(), intervalMs)` in those four engines.
--
-- next_run_at is the RESTART-SAFE cursor (a crash that paused the loop resumes from it). locked_by/
-- locked_until are the LEADER LEASE: a claim is an atomic compare-and-swap UPDATE, so exactly one instance
-- fires each interval across N replicas (premortem #200 §2 — no double-fire); a crashed leader's lease
-- expires and another instance reclaims. last_run_at/last_status/last_error/consecutive_failures are the
-- observability + bounded-backoff inputs.
--
-- GLOBAL by design — no workspace_id: a job's tickAll already fans out over every workspace internally, so
-- the cadence is a fleet-wide singleton. The name is intentionally NOT growth_/demand_/venture_/moat_-
-- prefixed so the #155 colocation gate does not class it as a governed metric surface.

CREATE TABLE IF NOT EXISTS scheduler_jobs (
  job_key text PRIMARY KEY,                              -- stable job identity (e.g. 'planning')
  interval_ms bigint NOT NULL,                           -- registered cadence in ms (bigint: weekly cadences)
  next_run_at timestamptz NOT NULL,                      -- the restart-safe cursor: when next eligible to run
  last_run_at timestamptz,                               -- when the last run completed, or null (never run)
  last_status text,                                      -- 'ok' | 'error' | null (observability)
  last_error text,                                       -- short redacted reason when last_status = 'error'
  consecutive_failures integer NOT NULL DEFAULT 0,       -- drives bounded backoff; reset to 0 on success
  locked_by text,                                        -- instance id holding the run lease, or null
  locked_until timestamptz,                              -- when the lease expires (crashed leader auto-frees)
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scheduler_jobs_status_ck CHECK (last_status IN ('ok','error') OR last_status IS NULL)
);

-- The claim work-list predicate (due AND unleased-or-expired) is point-lookups by primary key, so no extra
-- index is needed; a partial index over next_run_at would only help a full-table sweep we never do.
