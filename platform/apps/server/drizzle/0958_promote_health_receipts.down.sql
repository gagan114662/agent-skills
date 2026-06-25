ALTER TABLE deploy_releases
  DROP COLUMN IF EXISTS promote_health_detail,
  DROP COLUMN IF EXISTS promote_health_ok;
