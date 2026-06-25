DROP INDEX IF EXISTS deploy_releases_release_ref_uk;

ALTER TABLE deploy_releases
  DROP CONSTRAINT IF EXISTS deploy_releases_status_ck;

ALTER TABLE deploy_releases
  ADD CONSTRAINT deploy_releases_status_ck
  CHECK (status IN ('deploy_failed','smoke_failed','rolled_back','promoted','escalated'));
