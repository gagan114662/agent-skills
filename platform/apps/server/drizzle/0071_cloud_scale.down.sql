-- Reverse of 0071_cloud_scale.
ALTER TABLE agent_sessions DROP COLUMN IF EXISTS region;
DROP TABLE IF EXISTS tenant_usage;
