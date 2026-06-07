-- Reverse of 0002_rbac.
ALTER TABLE agents DROP COLUMN IF EXISTS deactivated_at;
DROP INDEX IF EXISTS permissions_member_idx;
ALTER TABLE permissions DROP CONSTRAINT IF EXISTS permissions_member_resource_uniq;
ALTER TABLE permissions DROP COLUMN IF EXISTS created_at;
ALTER TABLE permissions DROP COLUMN IF EXISTS granted_by_member_id;
