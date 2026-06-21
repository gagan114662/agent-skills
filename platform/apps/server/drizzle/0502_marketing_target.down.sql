-- Revert #502: drop the structured marketing-target columns.
ALTER TABLE workspace_onboarding DROP COLUMN IF EXISTS target_competitors;
ALTER TABLE workspace_onboarding DROP COLUMN IF EXISTS target_audience;
ALTER TABLE workspace_onboarding DROP COLUMN IF EXISTS target_positioning;
ALTER TABLE workspace_onboarding DROP COLUMN IF EXISTS target_name;
