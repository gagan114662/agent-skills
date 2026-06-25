ALTER TABLE deploy_releases
  ADD COLUMN IF NOT EXISTS promote_health_ok boolean,
  ADD COLUMN IF NOT EXISTS promote_health_detail text;
