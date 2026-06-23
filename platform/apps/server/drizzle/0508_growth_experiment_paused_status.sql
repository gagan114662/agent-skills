-- Issue #617: let the growth loop auto-pause underperforming campaign/content experiments.
ALTER TABLE growth_experiments
  DROP CONSTRAINT IF EXISTS growth_experiments_status_ck;

ALTER TABLE growth_experiments
  ADD CONSTRAINT growth_experiments_status_ck
  CHECK (status IN ('proposed','approved','running','paused','completed','abandoned'));
