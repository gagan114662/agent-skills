-- Issue #905: source-cohort targeting for growth experiments.
ALTER TABLE growth_experiments
  ADD COLUMN IF NOT EXISTS target_source text NOT NULL DEFAULT '';
