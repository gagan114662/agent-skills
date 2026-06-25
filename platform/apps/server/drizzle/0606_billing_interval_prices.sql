-- 0606_billing_interval_prices — self-serve monthly/annual checkout (#606).
-- Annual subscriptions need their own recurring provider price. Existing rows are monthly.
ALTER TABLE billing_plan_prices
  ADD COLUMN billing_interval text NOT NULL DEFAULT 'month';

ALTER TABLE billing_plan_prices
  DROP CONSTRAINT billing_plan_prices_pkey;

ALTER TABLE billing_plan_prices
  ADD PRIMARY KEY (workspace_id, plan_key, provider, billing_interval);
