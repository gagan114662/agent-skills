-- Deliverable Verification Layer (#191, ADR-0191): "nothing ships unverified". Two additive,
-- append-only tables; no existing table is touched (zero sibling-migration collision risk). ADR / spec /
-- migration share the 0191 issue-number slot per the by-issue numbering convention (ADR-0099's note).

-- verification_criteria: the DEFINITION OF DONE derived from a session's brief BEFORE it executes
-- (#191 AC #1) — the spec a deliverable is graded against, stored + visible. deliverable_ref is a soft
-- ref (a session/deliverable id) so the DoD outlives a pruned subject; only workspace_id carries the #3
-- tenant boundary. brief_digest is redacted (#25) before persist.
CREATE TABLE IF NOT EXISTS verification_criteria (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  deliverable_ref text NOT NULL,
  deliverable_kind text NOT NULL,
  reversibility text NOT NULL,
  criteria jsonb NOT NULL,
  brief_digest text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT verification_criteria_kind_ck
    CHECK (deliverable_kind IN ('outbound_content','support_reply','campaign_change','venture_deploy')),
  CONSTRAINT verification_criteria_reversibility_ck
    CHECK (reversibility IN ('reversible','cheap','irreversible'))
);

-- "the latest DoD for this deliverable" — (workspace, deliverable_ref) newest-first.
CREATE INDEX IF NOT EXISTS verification_criteria_deliverable_idx
  ON verification_criteria (workspace_id, deliverable_ref, created_at);

-- verification_verdicts: each INDEPENDENT verifier pass (#191 AC #2-4). One row per verdict: the terminal
-- action, the pass bit + aggregate confidence, the reversibility class, whether the grader was
-- independent of the worker, whether the production-grounded final tier was met (premortem #3), the
-- fail→fix retry count, the per-criterion checks (redacted evidence — the proof on the card), and the
-- #13 approval/escalation it opened. worker/grader/approval ids are soft refs (no FK).
CREATE TABLE IF NOT EXISTS verification_verdicts (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  deliverable_ref text NOT NULL,
  deliverable_kind text NOT NULL,
  status text NOT NULL,
  passed boolean NOT NULL,
  confidence double precision NOT NULL,
  reversibility text NOT NULL,
  independence_ok boolean NOT NULL,
  production_grounded boolean NOT NULL,
  retry_count integer NOT NULL DEFAULT 0,
  checks jsonb NOT NULL,
  worker_member_id uuid,
  grader_member_id uuid,
  approval_request_id uuid,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT verification_verdicts_kind_ck
    CHECK (deliverable_kind IN ('outbound_content','support_reply','campaign_change','venture_deploy')),
  CONSTRAINT verification_verdicts_status_ck
    CHECK (status IN ('auto_proceed','request_approval','return_to_worker','escalate')),
  CONSTRAINT verification_verdicts_reversibility_ck
    CHECK (reversibility IN ('reversible','cheap','irreversible'))
);

-- "the latest verdict for this deliverable" — (workspace, deliverable_ref) newest-first.
CREATE INDEX IF NOT EXISTS verification_verdicts_deliverable_idx
  ON verification_verdicts (workspace_id, deliverable_ref, created_at);
-- The console / trailing-window read is "(workspace) newest-first".
CREATE INDEX IF NOT EXISTS verification_verdicts_workspace_created_idx
  ON verification_verdicts (workspace_id, created_at);
