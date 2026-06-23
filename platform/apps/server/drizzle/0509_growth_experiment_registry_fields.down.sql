-- Roll back issue #616 registry fields.
ALTER TABLE growth_experiments
  DROP COLUMN IF EXISTS decision,
  DROP COLUMN IF EXISTS result,
  DROP COLUMN IF EXISTS metric_key,
  DROP COLUMN IF EXISTS variant;
