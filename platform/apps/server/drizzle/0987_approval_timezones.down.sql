ALTER TABLE approval_requests
  DROP COLUMN IF EXISTS expires_at_timezone;

ALTER TABLE workspaces
  DROP COLUMN IF EXISTS timezone;

