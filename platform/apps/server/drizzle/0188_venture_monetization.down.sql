-- Rollback 0188 (#188): drop the venture monetization tables in reverse dependency order.
DROP TABLE IF EXISTS monetization_revenue;
DROP TABLE IF EXISTS monetization_experiments;
DROP TABLE IF EXISTS monetization_plans;
