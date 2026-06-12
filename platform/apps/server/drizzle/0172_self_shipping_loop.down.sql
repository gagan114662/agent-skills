-- Rollback Self-Shipping Loop (#172). Indexes drop with their tables.
DROP TABLE IF EXISTS build_loop_reviews;
DROP TABLE IF EXISTS build_loop_runs;
