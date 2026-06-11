-- SRE Loop (#112, ADR-0112): durable, workspace-scoped incidents from SLO breaches.
-- One table: sre_incidents. A breach opens a row (firing), launches a triage agent, and resolves the
-- row on recovery (drafting a postmortem). Session-id column is a soft reference (no FK) so the
-- incident outlives pruned session history; only workspace_id carries the #3 tenant boundary.
-- Number-by-ISSUE (0112) to dodge sibling-branch prefix collisions in the shared sequence.

CREATE TABLE IF NOT EXISTS sre_incidents (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  service text NOT NULL,
  slo_kind text NOT NULL,
  severity text NOT NULL DEFAULT 'warning',
  status text NOT NULL DEFAULT 'firing',
  observed_value double precision NOT NULL,
  target_value double precision NOT NULL,
  budget_remaining double precision NOT NULL,
  triage_session_id uuid,
  postmortem_path text,
  opened_at timestamptz NOT NULL DEFAULT now(),
  last_notified_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sre_incidents_status_ck CHECK (status IN ('firing','escalated','resolved')),
  CONSTRAINT sre_incidents_slo_kind_ck CHECK (slo_kind IN ('availability','latency_p95','queue_lag')),
  CONSTRAINT sre_incidents_severity_ck CHECK (severity IN ('warning','critical'))
);

CREATE INDEX IF NOT EXISTS sre_incidents_workspace_status_idx
  ON sre_incidents (workspace_id, status);
CREATE INDEX IF NOT EXISTS sre_incidents_service_idx
  ON sre_incidents (workspace_id, service, slo_kind);

-- One OPEN incident per (workspace, service, slo_kind): a sustained breach never floods the queue.
-- Partial unique index (resolved rows are exempt, so the slot frees on recovery).
CREATE UNIQUE INDEX IF NOT EXISTS sre_incidents_open_uk
  ON sre_incidents (workspace_id, service, slo_kind)
  WHERE status <> 'resolved';
