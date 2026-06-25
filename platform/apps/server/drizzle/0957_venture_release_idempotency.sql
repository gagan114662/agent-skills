ALTER TABLE deploy_releases
  DROP CONSTRAINT IF EXISTS deploy_releases_status_ck;

ALTER TABLE deploy_releases
  ADD CONSTRAINT deploy_releases_status_ck
  CHECK (status IN ('pending_promote','deploy_failed','smoke_failed','rolled_back','promoted','escalated'));

CREATE UNIQUE INDEX IF NOT EXISTS deploy_releases_release_ref_uk
  ON deploy_releases (workspace_id, venture_id, release_ref);
