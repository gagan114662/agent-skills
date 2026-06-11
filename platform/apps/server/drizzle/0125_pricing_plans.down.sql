-- Down for 0125_pricing_plans (#125). Drop the two additive tables; nothing else referenced them.
DROP TABLE IF EXISTS billing_plan_prices;
DROP TABLE IF EXISTS workspace_plans;
