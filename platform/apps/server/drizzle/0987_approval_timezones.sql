-- 0987_approval_timezones - tenant timezone + approval expiry display zone.

ALTER TABLE workspaces
  ADD COLUMN timezone text NOT NULL DEFAULT 'UTC';

ALTER TABLE approval_requests
  ADD COLUMN expires_at_timezone text NOT NULL DEFAULT 'UTC';
