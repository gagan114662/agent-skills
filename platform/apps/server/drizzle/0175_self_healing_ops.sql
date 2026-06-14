-- Self-Healing Ops (#193, ADR-0174): per-venture health incidents + bounded auto-remediation.
-- One table: self_healing_remediations. A breached venture-surface signal (uptime / error_rate /
-- queue_depth / stuck_agent) opens a row (firing); the engine picks a reversibility-classed action
-- (restart auto / rollback / scale within caps), dispatches a remediation session or a #13 approval,
-- retries an auto action ONCE, then escalates; recovery resolves the row and files a postmortem issue.
--
-- Session / approval / deploy ids are SOFT references (no FK): they are audit history that may be
-- pruned independently and the incident must outlive them. Only workspace_id carries the #3 tenant
-- boundary (ON DELETE CASCADE). The flywheel `ops_incident` failure class is a TS-only enum change
-- (the `failure_class` column is plain text with no DB CHECK) — no enum migration needed here.
-- Number-by-ISSUE-adjacent (0175, the next free prefix) to dodge sibling-branch collisions.

CREATE TABLE IF NOT EXISTS self_healing_remediations (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- The venture surface being monitored (e.g. a deployment host, a venture id, or the owner workspace).
  surface_key text NOT NULL,
  -- Which health signal breached.
  signal text NOT NULL,
  status text NOT NULL DEFAULT 'firing',
  -- The chosen remediation action (null until decided), its reversibility class, and whether it needs a human.
  action text,
  reversibility text,
  requires_approval boolean NOT NULL DEFAULT true,
  -- Soft refs to the #13 approval and the dispatched remediation session.
  approval_request_id uuid,
  remediation_session_id uuid,
  -- How many auto-remediation attempts have run (retry-once ⇒ escalate when this would exceed the cap).
  attempts integer NOT NULL DEFAULT 0,
  observed_value double precision,
  threshold_value double precision,
  detail text,
  -- The self-filed postmortem issue ref (null until resolved + filed).
  postmortem_issue_ref text,
  opened_at timestamptz NOT NULL DEFAULT now(),
  last_action_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT self_healing_remediations_status_ck
    CHECK (status IN ('firing','remediating','escalated','resolved')),
  CONSTRAINT self_healing_remediations_signal_ck
    CHECK (signal IN ('uptime','error_rate','queue_depth','stuck_agent')),
  CONSTRAINT self_healing_remediations_action_ck
    CHECK (action IS NULL OR action IN ('restart','rollback','scale_up','escalate','none')),
  CONSTRAINT self_healing_remediations_reversibility_ck
    CHECK (reversibility IS NULL OR reversibility IN ('reversible','cheap','irreversible'))
);

CREATE INDEX IF NOT EXISTS self_healing_remediations_workspace_status_idx
  ON self_healing_remediations (workspace_id, status);
CREATE INDEX IF NOT EXISTS self_healing_remediations_surface_idx
  ON self_healing_remediations (workspace_id, surface_key, signal);

-- One OPEN incident per (workspace, surface_key, signal): a sustained breach never floods the queue.
-- Partial unique (resolved rows are exempt, so the slot frees on recovery) — mirrors sre_incidents.
CREATE UNIQUE INDEX IF NOT EXISTS self_healing_remediations_open_uk
  ON self_healing_remediations (workspace_id, surface_key, signal)
  WHERE status <> 'resolved';
