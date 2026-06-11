-- Down for 0101_demand_validation_rails (#101). Drop the three additive tables (children first); nothing
-- else referenced them.
DROP TABLE IF EXISTS demand_refunds;
DROP TABLE IF EXISTS demand_signals;
DROP TABLE IF EXISTS demand_experiments;
