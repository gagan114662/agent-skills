ALTER TABLE workspace_onboarding
  ADD COLUMN first_run_stage text,
  ADD COLUMN first_run_target text,
  ADD COLUMN first_run_finding text,
  ADD COLUMN first_run_artifact_title text,
  ADD COLUMN first_run_artifact_summary text,
  ADD COLUMN first_run_receipt text,
  ADD COLUMN first_run_recorded_at timestamptz;
