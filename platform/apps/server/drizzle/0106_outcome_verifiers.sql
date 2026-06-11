-- Outcome Verifiers (#106, ADR-0106): turn non-code claims (deploy live? revenue real? growth moved?
-- fix held?) into durable, tenant-scoped, measured verdicts. One additive, append-only table; no
-- existing table is touched (zero sibling-migration collision risk).

-- Each row is one verification verdict: the kind, the verified subject (claim_ref, a soft ref so the
-- verdict outlives a pruned deployment/venture/fingerprint), the measured value + threshold behind the
-- verdict, a redacted detail, and (on a measured failure) the #13 escalation it opened. Only
-- workspace_id carries the #3 tenant boundary. detail is redacted (#25) before persist.
CREATE TABLE IF NOT EXISTS verifier_results (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind text NOT NULL,
  claim_ref text NOT NULL,
  status text NOT NULL,
  measured_value double precision NOT NULL,
  threshold double precision NOT NULL,
  detail text NOT NULL,
  escalation_request_id uuid,
  source text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT verifier_results_kind_ck CHECK (kind IN ('deploy_live','revenue_real','growth_metric','fix_held')),
  CONSTRAINT verifier_results_status_ck CHECK (status IN ('passed','failed','errored'))
);

-- The "latest verdict for this claim" read is "(workspace, kind, claim_ref) newest-first".
CREATE INDEX IF NOT EXISTS verifier_results_claim_idx
  ON verifier_results (workspace_id, kind, claim_ref, created_at);
-- The console / trailing-window read is "(workspace) newest-first".
CREATE INDEX IF NOT EXISTS verifier_results_workspace_created_idx
  ON verifier_results (workspace_id, created_at);
