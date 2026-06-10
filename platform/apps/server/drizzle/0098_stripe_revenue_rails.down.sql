-- Down: 0098_stripe_revenue_rails (issue #98). Drops the three revenue tables (indexes + FKs go with
-- them). revenue_evidence references revenue_events, so drop it first.
DROP TABLE IF EXISTS revenue_evidence;
DROP TABLE IF EXISTS revenue_events;
DROP TABLE IF EXISTS payment_links;
