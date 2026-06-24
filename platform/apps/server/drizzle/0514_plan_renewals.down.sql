DROP INDEX IF EXISTS workspace_plans_renewal_idx;
ALTER TABLE workspace_plans
  DROP CONSTRAINT IF EXISTS workspace_plans_retry_count_ck,
  DROP CONSTRAINT IF EXISTS workspace_plans_renewal_status_ck,
  DROP COLUMN IF EXISTS last_payment_failed_at,
  DROP COLUMN IF EXISTS retry_scheduled_at,
  DROP COLUMN IF EXISTS retry_count,
  DROP COLUMN IF EXISTS renewal_status,
  DROP COLUMN IF EXISTS next_billing_at,
  DROP COLUMN IF EXISTS expires_at;
