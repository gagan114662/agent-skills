-- Revert #294 SEO rank tracking.
DROP INDEX IF EXISTS seo_rank_observations_workspace_keyword_idx;
DROP INDEX IF EXISTS seo_rank_observations_receipt_uk;
DROP TABLE IF EXISTS seo_rank_observations;
