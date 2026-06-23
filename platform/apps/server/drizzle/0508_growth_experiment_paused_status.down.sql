-- Roll back issue #617 paused lifecycle support.
UPDATE growth_experiments
SET status = 'abandoned', updated_at = now()
WHERE status = 'paused';

ALTER TABLE growth_experiments
  DROP CONSTRAINT IF EXISTS growth_experiments_status_ck;

ALTER TABLE growth_experiments
  ADD CONSTRAINT growth_experiments_status_ck
  CHECK (status IN ('proposed','approved','running','completed','abandoned'));
