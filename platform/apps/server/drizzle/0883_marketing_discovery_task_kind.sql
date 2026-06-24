ALTER TABLE marketing_tasks
  DROP CONSTRAINT IF EXISTS marketing_tasks_kind_ck;

ALTER TABLE marketing_tasks
  ADD CONSTRAINT marketing_tasks_kind_ck CHECK (kind IN ('welcome','mention','discovery'));
