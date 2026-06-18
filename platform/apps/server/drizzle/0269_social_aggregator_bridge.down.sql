-- Revert #269 Echo social aggregator bridge. Drop the per-network receipts first (FK to social_posts).
DROP TABLE IF EXISTS social_post_results;
DROP TABLE IF EXISTS social_posts;
