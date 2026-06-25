-- Down for 0606_billing_interval_prices (#606).
DELETE FROM billing_plan_prices WHERE billing_interval <> 'month';

ALTER TABLE billing_plan_prices
  DROP CONSTRAINT billing_plan_prices_pkey;

ALTER TABLE billing_plan_prices
  ADD PRIMARY KEY (workspace_id, plan_key, provider);

ALTER TABLE billing_plan_prices
  DROP COLUMN billing_interval;
