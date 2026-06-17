-- Revert #320 workspace product context.
ALTER TABLE workspace_onboarding DROP COLUMN IF EXISTS product_context;
