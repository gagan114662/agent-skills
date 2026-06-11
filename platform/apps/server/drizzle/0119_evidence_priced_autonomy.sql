-- Evidence-Priced Autonomy (#119, ADR-0119): price the human/AI split per approval action class on
-- measured decision error, with structural hysteresis and invariant classes that can never auto-relax.
-- Two additive, append-only tables; no existing table is touched.

-- (1) Per-decision evidence: one row per terminal human decision on a gated action, written in the
-- same transaction as the #13 decision so it can never drift from approval_events. request_id is a
-- soft reference (no FK) so evidence outlives a pruned request; only workspace_id carries the #3 tenant
-- boundary. edit_distance is set only for an 'edited' outcome on drafted content.
CREATE TABLE IF NOT EXISTS gate_evidence (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  action_type text NOT NULL,
  outcome text NOT NULL,
  edit_distance integer,
  time_to_decision_ms integer NOT NULL,
  request_id uuid,
  decided_by_member_id uuid REFERENCES members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT gate_evidence_outcome_ck CHECK (outcome IN ('approved','rejected','edited'))
);
-- The trailing-window read is "last N decisions for (workspace, action_type)".
CREATE INDEX IF NOT EXISTS gate_evidence_action_created_idx
  ON gate_evidence (workspace_id, action_type, created_at);

-- (2) Boundary-change audit: one row per RELAX/RETIGHTEN the pricer applies, carrying the measured
-- error rate that earned it, the window size, the affected #95 approval_policies rule (soft ref), and
-- the reason. This is the #13-style audit for boundary moves and the Founder Console history source.
CREATE TABLE IF NOT EXISTS gate_boundary_changes (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  action_type text NOT NULL,
  direction text NOT NULL,
  error_rate double precision NOT NULL,
  window_size integer NOT NULL,
  policy_rule_id uuid,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT gate_boundary_changes_direction_ck CHECK (direction IN ('RELAX','RETIGHTEN'))
);
CREATE INDEX IF NOT EXISTS gate_boundary_changes_workspace_created_idx
  ON gate_boundary_changes (workspace_id, created_at);
