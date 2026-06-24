ALTER TABLE workspace_plans
  ADD COLUMN expires_at timestamptz,
  ADD COLUMN next_billing_at timestamptz,
  ADD COLUMN renewal_status text NOT NULL DEFAULT 'active',
  ADD COLUMN retry_count integer NOT NULL DEFAULT 0,
  ADD COLUMN retry_scheduled_at timestamptz,
  ADD COLUMN last_payment_failed_at timestamptz;

UPDATE workspace_plans
SET
  expires_at = coalesce(expires_at, activated_at + interval '30 days'),
  next_billing_at = coalesce(next_billing_at, activated_at + interval '30 days');

ALTER TABLE workspace_plans
  ALTER COLUMN expires_at SET NOT NULL,
  ALTER COLUMN next_billing_at SET NOT NULL,
  ADD CONSTRAINT workspace_plans_renewal_status_ck
    CHECK (renewal_status IN ('active','past_due','expired','canceled')),
  ADD CONSTRAINT workspace_plans_retry_count_ck CHECK (retry_count >= 0);

CREATE INDEX workspace_plans_renewal_idx
  ON workspace_plans (renewal_status, retry_scheduled_at);
