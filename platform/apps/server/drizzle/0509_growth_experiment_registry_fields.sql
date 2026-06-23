-- Issue #616: durable experiment registry fields for before/after learning.
ALTER TABLE growth_experiments
  ADD COLUMN IF NOT EXISTS variant text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS metric_key text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS result text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS decision text NOT NULL DEFAULT '';

UPDATE growth_experiments
SET result = result_summary
WHERE result = '' AND result_summary <> '';
