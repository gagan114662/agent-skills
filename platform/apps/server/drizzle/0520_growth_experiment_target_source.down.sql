-- Roll back issue #905 source-cohort targeting.
ALTER TABLE growth_experiments
  DROP COLUMN IF EXISTS target_source;
