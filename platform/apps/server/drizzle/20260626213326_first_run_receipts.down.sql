ALTER TABLE workspace_onboarding
  DROP COLUMN IF EXISTS first_run_recorded_at,
  DROP COLUMN IF EXISTS first_run_receipt,
  DROP COLUMN IF EXISTS first_run_artifact_summary,
  DROP COLUMN IF EXISTS first_run_artifact_title,
  DROP COLUMN IF EXISTS first_run_finding,
  DROP COLUMN IF EXISTS first_run_target,
  DROP COLUMN IF EXISTS first_run_stage;
